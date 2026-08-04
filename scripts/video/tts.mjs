/**
 * VAIZ — TTS (Text-to-Speech)
 *
 * plan.json の各 scene.narration を日本語音声に変換する。
 * エンジンは edge-tts (無料 / APIキー不要 / 日本語ネイティブ音声)。
 *
 * 使い方: bun run scripts/video/tts.mjs
 * 環境変数: (任意) TTS_VOICE, TTS_RATE
 * 入力: out/plan.json
 * 出力: out/audio/{0..N}.wav (24kHz mono PCM), out/timing.json
 */

import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const AUDIO_DIR = path.join(OUT_DIR, 'audio');
const TTS_HELPER = path.join(__dirname, 'tts_helper.py');
const PYTHON = process.env.PYTHON_BIN || 'python3';

// ═══════════════════════════════════════════════════════════════
// 依存確認 — 入っていないときだけ入れる
// ═══════════════════════════════════════════════════════════════
function ensureDeps() {
  try {
    execFileSync(PYTHON, ['-c', 'import edge_tts'], { stdio: 'pipe' });
    console.log('edge-tts is available.');
    return;
  } catch {
    console.log('edge-tts not found. Installing...');
  }

  // system Python 直下だと PEP 668 で弾かれるので、その場合だけ緩める
  for (const extra of [[], ['--break-system-packages']]) {
    try {
      execFileSync(PYTHON, ['-m', 'pip', 'install', '--quiet', ...extra, 'edge-tts'], {
        stdio: 'inherit',
      });
      return;
    } catch {
      /* 次の組み合わせを試す */
    }
  }
  throw new Error('Failed to install edge-tts');
}

// ═══════════════════════════════════════════════════════════════
// 1 クリップの TTS を実行 → 秒数を返す
// ═══════════════════════════════════════════════════════════════
function synthesizeOne(index, text, outPath) {
  console.log(`  [${index}] ${text.substring(0, 40)}...`);

  // execFileSync なのでシェルを経由しない = 日本語やクォートのエスケープ不要
  const stdout = execFileSync(PYTHON, [TTS_HELPER, '--text', text, '--output', outPath], {
    encoding: 'utf-8',
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid duration for scene ${index}: "${stdout.trim()}"`);
  }

  console.log(`  [${index}] → ${duration.toFixed(2)}s`);
  return duration;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ TTS Generator ===');

  ensureDeps();

  const plan = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'plan.json'), 'utf-8'));
  if (!plan.scenes || plan.scenes.length === 0) {
    throw new Error('plan.json has no scenes');
  }

  await fs.mkdir(AUDIO_DIR, { recursive: true });

  const timing = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const file = `${i}.wav`;
    const duration = synthesizeOne(i, plan.scenes[i].narration, path.join(AUDIO_DIR, file));
    timing.push({ index: i, file, duration });
  }

  await fs.writeFile(
    path.join(OUT_DIR, 'timing.json'),
    JSON.stringify(timing, null, 2),
    'utf-8',
  );

  const total = timing.reduce((s, t) => s + t.duration, 0);
  console.log(`\nDone. ${timing.length} clips, ${total.toFixed(2)}s of narration.`);
  console.log('Timing saved to out/timing.json');
}

// エントリポイントとして実行されたときだけ音声合成を走らせる。
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
