/**
 * VAIZ — Video Renderer
 *
 * ffmpeg で各シーンを合成:
 *   - 背景ぼかし + 元画像センター配置で 1080x1920 の縦型に（黒帯なし・切り落としなし）
 *   - zoompan による Ken Burns（偶数シーン=ズームイン, 奇数=ズームアウト）
 *   - シーン間 0.4s xfade トランジション
 *   - ASS 字幕焼き込み（日本語フォント Noto Sans CJK JP）
 *   - 音声は timing.json の実測長どおりの位置に配置（前後 0.3s 無音）
 *
 * 使い方: bun run scripts/video/render.mjs
 * 入力: out/plan.json, out/img/{0..N}.{jpg|png|webp}, out/audio/{0..N}.wav, out/timing.json
 * 出力: out/final.mp4 (H.264 / yuv420p / 1080x1920 / 30fps)
 */

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const IMG_DIR = path.join(OUT_DIR, 'img');
const AUDIO_DIR = path.join(OUT_DIR, 'audio');
const W = 1080;
const H = 1920;
const FPS = 30;
const XFADE_DUR = 0.4;
const PADDING = 0.3; // 各シーンの音声前後に入れる無音余白
const ZOOM_MAX = 1.18;
const FONT = 'Noto Sans CJK JP';
const FONT_SIZE = 52;
const SUB_MARGIN = 70;
// 日本語は空白がないので libass が自動改行してくれない。全角換算の文字数で自前で折る。
// 使える幅 = 1080 - 70*2 = 940px、全角 1 文字 ≒ FONT_SIZE px なので 18 文字弱が上限。
const MAX_LINE_WIDTH = 17;
// zoompan の拡大でぼやけないよう、合成は 2 倍解像度で行ってから縮小する
const SUPER = 2;

const TRANSITIONS = [
  'fade',
  'slideleft',
  'wipeleft',
  'fadeblack',
  'slideright',
  'wiperight',
  'circleopen',
];

// ═══════════════════════════════════════════════════════════════
// ffmpeg ヘルパー — execFileSync でシェルを経由しない
// (フィルタ文字列に ' や : が入るので、シェル経由だと必ず壊れる)
// ═══════════════════════════════════════════════════════════════
function ff(args, label = '') {
  if (label) console.log(`  [ffmpeg] ${label}`);
  try {
    return execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
      encoding: 'utf-8',
      timeout: 600_000,
      cwd: OUT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`ffmpeg failed (${label}):\n${detail.substring(0, 1500)}`);
  }
}

function ffprobeJson(file) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf-8', timeout: 60_000 },
  );
  return JSON.parse(out);
}

// ═══════════════════════════════════════════════════════════════
// タイムライン計算
//   clip[i] の尺       = PADDING + narration[i] + PADDING
//   clip[i] の開始位置 = 直前までの累積 - xfade の重なり分
// 字幕も音声もこの 1 つの計算結果を共有するので、ずれようがない。
// ═══════════════════════════════════════════════════════════════
function buildTimeline(timing) {
  let cursor = 0;
  const scenes = timing.map((t) => {
    const clipDur = t.duration + PADDING * 2;
    const start = cursor;
    cursor += clipDur - XFADE_DUR;
    return {
      index: t.index,
      clipDur,
      clipStart: start,
      audioStart: start + PADDING,
      audioEnd: start + PADDING + t.duration,
    };
  });
  const last = scenes[scenes.length - 1];
  return { scenes, total: last.clipStart + last.clipDur };
}

// ═══════════════════════════════════════════════════════════════
// ASS 字幕生成
// ═══════════════════════════════════════════════════════════════
function assTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text) {
  // ASS では \ が制御シーケンス、{} が override ブロックの開始になるため無害化する
  return text
    .replace(/\\/g, '＼')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

// 禁則処理 — 行頭に置けない文字 / 行末に置けない文字
const NO_LINE_START = '、。，．・：；？！ー〜）」』】〉》〕｝”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々…';
const NO_LINE_END = '（「『【〈《〔｛“‘';

/** 半角は 0.5 文字、全角は 1 文字として数える */
function charWidth(ch) {
  return /[ -~｡-ﾟ]/.test(ch) ? 0.5 : 1;
}

/** 日本語テキストを maxWidth（全角換算）で折り返す */
function wrapJapanese(text, maxWidth) {
  const lines = [];
  let line = '';
  let width = 0;

  for (const ch of text) {
    const w = charWidth(ch);
    // 行頭に来られない文字は、はみ出してでも前の行に残す
    if (line && width + w > maxWidth && !NO_LINE_START.includes(ch)) {
      let carry = '';
      // 行末に来られない文字（開き括弧など）は次の行へ送る
      if (NO_LINE_END.includes(line[line.length - 1])) {
        carry = line[line.length - 1];
        line = line.slice(0, -1);
      }
      lines.push(line);
      line = carry + ch;
      width = [...line].reduce((s, c) => s + charWidth(c), 0);
      continue;
    }
    line += ch;
    width += w;
  }
  if (line) lines.push(line);
  return lines;
}

function buildASS(plan, timeline) {
  const events = timeline.scenes.map((s, i) => {
    const lines = wrapJapanese(escapeAssText(plan.scenes[i].narration), MAX_LINE_WIDTH);
    if (lines.length > 3) {
      console.warn(
        `  WARNING: scene ${i} の字幕が ${lines.length} 行になります（ナレーションが長すぎ）`,
      );
    }
    const text = lines.join('\\N'); // ASS の強制改行
    return `Dialogue: 0,${assTime(s.audioStart)},${assTime(s.audioEnd)},Default,,0,0,0,,${text}`;
  });

  return `; VAIZ Generated ASS
[Script Info]
Title: VAIZ Subtitles
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${FONT},${FONT_SIZE},&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,4,2,2,${SUB_MARGIN},${SUB_MARGIN},170,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}

// ═══════════════════════════════════════════════════════════════
// シーンクリップ（映像のみ）を生成
// ═══════════════════════════════════════════════════════════════
function findImage(i) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const p = path.join(IMG_DIR, `${i}.${ext}`);
    if (existsSync(p) && statSync(p).size > 0) return p;
  }
  throw new Error(`No image found for scene ${i} (looked for out/img/${i}.{jpg,png,webp})`);
}

function kenBurnsExpr(i, frames) {
  // zoom の累積変数を使うと ffmpeg のバージョン差で挙動が揺れるので、
  // 出力フレーム番号 on の一次関数として書く（完全に決定的）。
  const span = Math.max(frames - 1, 1);
  const delta = (ZOOM_MAX - 1).toFixed(4);
  return i % 2 === 0
    ? `1+${delta}*on/${span}` // ズームイン
    : `${ZOOM_MAX}-${delta}*on/${span}`; // ズームアウト
}

function renderSceneClip(i, clipDur) {
  const imgIn = findImage(i);
  const clipOut = path.join(OUT_DIR, `clip_${i}.mp4`);
  const frames = Math.round(clipDur * FPS);

  const bigW = W * SUPER;
  const bigH = H * SUPER;

  // 背景: 画面を埋めるまで拡大 → 切り抜き → ぼかし
  // 前景: 元画像を全部見えるサイズに縮小してセンター配置
  // 仕上げ: 合成結果に zoompan をかけて 1080x1920 へ縮小
  const filter = [
    `[0:v]split=2[bg][fg]`,
    `[bg]scale=216:384:force_original_aspect_ratio=increase,crop=216:384,gblur=sigma=10,scale=${bigW}:${bigH},setsar=1[bgv]`,
    `[fg]scale=${bigW}:${bigH}:force_original_aspect_ratio=decrease,setsar=1[fgv]`,
    `[bgv][fgv]overlay=(W-w)/2:(H-h)/2,` +
      `zoompan=z='${kenBurnsExpr(i, frames)}':` +
      `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
      `d=${frames}:s=${W}x${H}:fps=${FPS},` +
      `format=yuv420p[v]`,
  ].join(';');

  // -loop を使わず単一フレーム入力にする。zoompan が d フレームを生成するので、
  // ループさせるとズームが途中でリセットされる。
  ff(
    [
      '-i', imgIn,
      '-filter_complex', filter,
      '-map', '[v]',
      '-frames:v', String(frames),
      '-r', String(FPS),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-an',
      clipOut,
    ],
    `clip_${i} (${clipDur.toFixed(2)}s, ${frames}f)`,
  );

  return clipOut;
}

// ═══════════════════════════════════════════════════════════════
// xfade で全シーンを連結（映像のみ）
// ═══════════════════════════════════════════════════════════════
function concatWithXfade(clipPaths, timeline) {
  if (clipPaths.length === 1) return clipPaths[0];

  let currentPath = clipPaths[0];
  let accumulated = timeline.scenes[0].clipDur;
  const temps = [];

  for (let i = 1; i < clipPaths.length; i++) {
    const outPath = path.join(OUT_DIR, `merged_${i}.mp4`);
    const offset = (accumulated - XFADE_DUR).toFixed(3);
    const xfadeType = TRANSITIONS[(i - 1) % TRANSITIONS.length];

    ff(
      [
        '-i', currentPath,
        '-i', clipPaths[i],
        '-filter_complex',
        `[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];` +
          `[a][b]xfade=transition=${xfadeType}:duration=${XFADE_DUR}:offset=${offset},format=yuv420p[v]`,
        '-map', '[v]',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-r', String(FPS),
        '-an',
        outPath,
      ],
      `xfade ${i - 1}→${i} (${xfadeType}) @${offset}s`,
    );

    temps.push(outPath);
    accumulated += timeline.scenes[i].clipDur - XFADE_DUR;
    currentPath = outPath;
  }

  return currentPath;
}

// ═══════════════════════════════════════════════════════════════
// 音声トラック配置 + 字幕焼き込み → final.mp4
// ═══════════════════════════════════════════════════════════════
async function mergeAudioAndSubtitles(videoPath, plan, timeline) {
  const finalPath = path.join(OUT_DIR, 'final.mp4');
  const assName = 'subtitles.ass'; // cwd が OUT_DIR なので相対名でよい（パスのエスケープ不要）

  await fs.writeFile(path.join(OUT_DIR, assName), buildASS(plan, timeline), 'utf-8');
  console.log(`  ASS subtitles written (${plan.scenes.length} events)`);

  // 各 WAV を timeline の位置まで adelay でずらし、amix で 1 本にまとめる。
  // 重なりはないので normalize=0 で原音量を保つ。
  const inputs = ['-i', videoPath];
  const chains = [`[0:v]ass=${assName}[v]`];
  const labels = [];

  timeline.scenes.forEach((s, i) => {
    inputs.push('-i', path.join(AUDIO_DIR, `${i}.wav`));
    const delayMs = Math.round(s.audioStart * 1000);
    chains.push(
      `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono,` +
        `adelay=${delayMs}:all=1[a${i}]`,
    );
    labels.push(`[a${i}]`);
  });

  chains.push(
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,` +
      `aresample=48000,aformat=channel_layouts=stereo[a]`,
  );

  ff(
    [
      ...inputs,
      '-filter_complex', chains.join(';'),
      '-map', '[v]',
      '-map', '[a]',
      '-t', timeline.total.toFixed(3),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-r', String(FPS),
      '-movflags', '+faststart',
      finalPath,
    ],
    'final merge (video + audio + subs)',
  );

  return finalPath;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ Video Renderer ===');

  const plan = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'plan.json'), 'utf-8'));
  const timing = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'timing.json'), 'utf-8'));

  if (plan.scenes.length !== timing.length) {
    throw new Error(`Scene/timing mismatch: ${plan.scenes.length} vs ${timing.length}`);
  }

  // フォント確認（無いと日本語字幕が豆腐になる）
  try {
    execFileSync('bash', ['-c', `fc-list | grep -qi "${FONT}"`]);
    console.log(`Font '${FONT}' found.`);
  } catch {
    console.warn(`WARNING: font '${FONT}' not found — 日本語字幕が □ になります。`);
    console.warn('  Ubuntu: sudo apt-get install -y fonts-noto-cjk');
  }

  const timeline = buildTimeline(timing);
  console.log(`Timeline: ${timeline.scenes.length} scenes, ${timeline.total.toFixed(2)}s total`);

  // Step 1: 映像クリップ
  console.log(`\nRendering scene clips...`);
  const clipPaths = timeline.scenes.map((s, i) => renderSceneClip(i, s.clipDur));

  // Step 2: xfade 連結
  console.log('\nConcatenating with xfade transitions...');
  const mergedVideo = concatWithXfade(clipPaths, timeline);

  // Step 3: 音声 + 字幕
  console.log('\nPlacing audio and burning subtitles...');
  const finalPath = await mergeAudioAndSubtitles(mergedVideo, plan, timeline);

  // 中間ファイルの掃除（final.mp4 と subtitles.ass は残す）
  const leftovers = await fs.readdir(OUT_DIR);
  await Promise.all(
    leftovers
      .filter((f) => /^(clip_\d+|merged_\d+)\.mp4$/.test(f))
      .map((f) => fs.unlink(path.join(OUT_DIR, f)).catch(() => {})),
  );

  const info = ffprobeJson(finalPath);
  const duration = parseFloat(info.format.duration);
  const size = (parseInt(info.format.size, 10) / 1024 / 1024).toFixed(1);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');

  console.log('\n=== Render Complete ===');
  console.log(`Output: ${finalPath}`);
  console.log(`Duration: ${duration.toFixed(1)}s | Size: ${size}MB`);
  console.log(`Video: ${v?.codec_name} ${v?.width}x${v?.height} ${v?.r_frame_rate}`);
  console.log(`Audio: ${a?.codec_name} ${a?.sample_rate}Hz ${a?.channels}ch`);

  if (!a) throw new Error('final.mp4 has no audio stream');
  if (Math.abs(duration - timeline.total) > 1.5) {
    console.warn(
      `WARNING: duration ${duration.toFixed(2)}s differs from planned ${timeline.total.toFixed(2)}s`,
    );
  }
}

// エントリポイントとして実行されたときだけレンダリングを走らせる。
// import しただけで ffmpeg を起動しないようにするため。
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
  });
}

export { assTime, buildASS, buildTimeline, charWidth, escapeAssText, kenBurnsExpr, wrapJapanese };
