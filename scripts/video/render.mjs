/**
 * VAIZ — Video Renderer
 *
 * ffmpeg で各シーンを合成:
 *   - zoompan による Ken Burns エフェクト（奇数=ズームイン, 偶数=ズームアウト）
 *   - シーン間 0.4s xfade トランジション
 *   - ASS 字幕焼き込み（日本語フォント Noto Sans CJK JP）
 *   - 音声トラックは timing.json の実測長に合わせ、前後 0.3s 余白
 *
 * 使い方: bun run scripts/video/render.mjs
 * 入力: out/plan.json, out/img/{0..N}.png, out/audio/{0..N}.wav, out/timing.json
 * 出力: out/final.mp4 (H.264 / yuv420p / 1080x1920 / 30fps)
 */

import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
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
const PADDING = 0.3; // 音声前後の無音余白
const FONT = 'Noto Sans CJK JP';

// ═══════════════════════════════════════════════════════════════
// ASS 字幕生成
// ═══════════════════════════════════════════════════════════════
function buildASS(plan, timing) {
  let t = 0;
  const events = [];

  for (let i = 0; i < plan.scenes.length; i++) {
    const start = t;
    const dur = timing[i].duration;
    const end = t + dur;
    const nar = plan.scenes[i].narration;

    // ASS タイムスタンプ: H:MM:SS.cc (centiseconds)
    const fmt = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      const cs = Math.round((s % 1) * 100);
      return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
    };

    events.push(`Dialogue: 0,${fmt(start)},${fmt(end)},Default,,0,0,0,,${nar}`);
    t = end;
  }

  return `; VAIZ Generated ASS
[Script Info]
Title: VAIZ Subtitles
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${FONT},72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,20,20,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}`;
}

// ═══════════════════════════════════════════════════════════════
// ffmpeg ヘルパー
// ═══════════════════════════════════════════════════════════════
function ff(args, label = '') {
  const cmd = ['ffmpeg', '-y', ...args];
  if (label) console.log(`  [ffmpeg] ${label}`);
  try {
    const out = execSync(cmd.map((a) => `'${a}'`).join(' '), {
      encoding: 'utf-8',
      timeout: 300_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out;
  } catch (err) {
    throw new Error(`ffmpeg failed (${label}): ${err.stderr?.substring(0, 500) || err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// シーンクリップを個別生成（Ken Burns + 音声）
// ═══════════════════════════════════════════════════════════════
function renderSceneClip(i, duration) {
  const imgIn = path.join(IMG_DIR, `${i}.png`);
  const audioIn = path.join(AUDIO_DIR, `${i}.wav`);
  const clipOut = path.join(OUT_DIR, `clip_${i}.mp4`);

  // 画像のアスペクト比を 1080:1920 に合わせる（pad + scale）
  // Ken Burns: 奇数シーン=ズームイン、偶数=ズームアウト
  const totalFrames = Math.ceil(duration * FPS);
  const zoomExpr =
    i % 2 === 0
      ? `min(zoom+0.0008,1.4)`  // ズームアウト (偶数)
      : `if(eq(on,1),1.0,max(1.0-0.0008,1.0))`; // ズームイン (奇数)

  const zoompan =
    `zoompan=z='${zoomExpr}':` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${totalFrames}:s=${W}x${H}:fps=${FPS}`;

  const dur = (duration + PADDING * 2).toFixed(3);

  ff(
    [
      '-loop', '1',
      '-i', imgIn,
      '-i', audioIn,
      '-filter_complex',
      [
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,${zoompan},setpts=PTS-STARTPTS[v]`,
        `[1:a]adelay=${Math.round(PADDING * 1000)}|${Math.round(PADDING * 1000)},apad=pad_dur=${dur}[a]`,
      ].join(';'),
      '-map', '[v]',
      '-map', '[a]',
      '-t', dur,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-r', String(FPS),
      clipOut,
    ],
    `clip_${i} (${duration.toFixed(1)}s)`,
  );

  return clipOut;
}

// ═══════════════════════════════════════════════════════════════
// xfade で全シーンを連結
// ═══════════════════════════════════════════════════════════════
function concatWithXfade(clipPaths, timings) {
  if (clipPaths.length === 1) return clipPaths[0];

  let currentPath = clipPaths[0];
  let accumulatedDur = timings[0].duration + PADDING * 2;

  for (let i = 1; i < clipPaths.length; i++) {
    const nextPath = clipPaths[i];
    const nextDur = timings[i].duration + PADDING * 2;
    const outPath = path.join(OUT_DIR, `merged_${i}.mp4`);

    const offset = (accumulatedDur - XFADE_DUR).toFixed(3);

    // トランジション効果: fade, slideleft, slideright, wipeleft, wiperight を交互に
    const transitions = ['fade', 'slideleft', 'slideright', 'wipeleft', 'wiperight', 'fadeblack', 'fadewhite', 'circleopen'];
    const xfadeType = transitions[(i - 1) % transitions.length];

    ff(
      [
        '-i', currentPath,
        '-i', nextPath,
        '-filter_complex',
        `[0:v][1:v]xfade=transition=${xfadeType}:duration=${XFADE_DUR}:offset=${offset}[v]`,
        '-map', '[v]',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-pix_fmt', 'yuv420p',
        '-r', String(FPS),
        outPath,
      ],
      `xfade ${i - 1}→${i} (${xfadeType})`,
    );

    // 前のテンポラリを削除（最後以外）
    if (i > 1) {
      try { fs.unlinkSync(currentPath); } catch { /* ignore */ }
    }

    currentPath = outPath;
    accumulatedDur += nextDur - XFADE_DUR;
  }

  return currentPath;
}

// ═══════════════════════════════════════════════════════════════
// 音声トラックを合成して final.mp4 にマージ
// ═══════════════════════════════════════════════════════════════
function mergeAudioAndSubtitles(videoPath, plan, timings) {
  const finalPath = path.join(OUT_DIR, 'final.mp4');
  const assPath = path.join(OUT_DIR, 'subtitles.ass');

  // ASS ファイルを書き出し
  const assContent = buildASS(plan, timings);
  fs.writeFileSync(assPath, assContent, 'utf-8');
  console.log(`  ASS subtitles written (${plan.scenes.length} events)`);

  // 音声ファイルを concat して1つの音声トラックに
  const audioListPath = path.join(OUT_DIR, 'audio_list.txt');
  const audioFiles = timings.map((_, i) => `file 'audio/${i}.wav'`);
  fs.writeFileSync(audioListPath, audioFiles.join('\n'), 'utf-8');

  const concatAudioPath = path.join(OUT_DIR, 'all_audio.wav');
  ff(
    [
      '-f', 'concat', '-safe', '0',
      '-i', audioListPath,
      '-c', 'copy',
      concatAudioPath,
    ],
    'concat audio',
  );

  // 最終マージ: 動画 + 音声 + 字幕焼き込み
  ff(
    [
      '-i', videoPath,
      '-i', concatAudioPath,
      '-filter_complex',
      `[1:a]adelay=${Math.round(PADDING * 1000)}|${Math.round(PADDING * 1000)},apad=pad_dur=120[a]`,
      '-map', '0:v',
      '-map', '[a]',
      '-vf', `ass='${assPath}'`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-r', String(FPS),
      '-movflags', '+faststart',
      finalPath,
    ],
    'final merge (video + audio + subs)',
  );

  // テンポラリを掃除
  for (const f of [assPath, audioListPath, concatAudioPath]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }

  return finalPath;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ Video Renderer ===');

  // 入力ファイルの読み込み
  const plan = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'plan.json'), 'utf-8'));
  const timing = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'timing.json'), 'utf-8'));

  if (plan.scenes.length !== timing.length) {
    throw new Error(`Scene/timing mismatch: ${plan.scenes.length} vs ${timing.length}`);
  }

  // フォント確認
  console.log('Checking font...');
  try {
    execSync(`fc-list | grep -i "${FONT}"`, { encoding: 'utf-8' });
    console.log(`  Font '${FONT}' found.`);
  } catch {
    console.warn(`  Font '${FONT}' not found. Subtitles may not render correctly.`);
    console.warn('  In GitHub Actions, add: sudo apt-get install -y fonts-noto-cjk');
  }

  // Step 1: 各シーンのクリップを生成
  console.log(`\nRendering ${plan.scenes.length} scene clips...`);
  const clipPaths = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const clipPath = renderSceneClip(i, timing[i].duration);
    clipPaths.push(clipPath);
  }

  // Step 2: xfade で連結
  console.log('\nConcatenating with xfade transitions...');
  const mergedVideo = concatWithXfade(clipPaths, timing);

  // Step 3: 音声 + 字幕をマージ
  console.log('\nMerging audio and burning subtitles...');
  const finalPath = mergeAudioAndSubtitles(mergedVideo, plan, timing);

  // クリーンアップ: マージ中間ファイル
  for (const p of clipPaths) {
    if (p !== mergedVideo) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
  try { fs.unlinkSync(mergedVideo); } catch { /* ignore */ }

  // 最終ファイルの情報
  const probe = execSync(
    `ffprobe -v quiet -print_format json -show_format -show_streams "${finalPath}"`,
    { encoding: 'utf-8' },
  );
  const info = JSON.parse(probe);
  const duration = parseFloat(info.format.duration);
  const size = (parseInt(info.format.size) / 1024 / 1024).toFixed(1);

  console.log(`\n=== Render Complete ===`);
  console.log(`Output: ${finalPath}`);
  console.log(`Duration: ${duration.toFixed(1)}s | Size: ${size}MB`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
