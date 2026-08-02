/**
 * VAIZ — TTS (Text-to-Speech)
 *
 * plan.json の各 scene.narration を日本語音声に変換する。
 * 第一候補: Kokoro (CPU 推論, Apache 2.0)
 * フォールバック: edge-tts
 *
 * 使い方: bun run scripts/video/tts.mjs
 * 環境変数: なし (Python + pip 必須)
 * 入力: out/plan.json
 * 出力: out/audio/{0..N}.wav, out/timing.json
 */

import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const AUDIO_DIR = path.join(OUT_DIR, 'audio');
const TTS_HELPER = path.join(__dirname, 'tts_helper.py');

// ═══════════════════════════════════════════════════════════════
// Python 環境セットアップ
// ═══════════════════════════════════════════════════════════════
function ensureDeps() {
  console.log('Installing Python TTS dependencies...');
  const pipOpts = '--break-system-packages';
  try {
    execSync(`pip install ${pipOpts} edge-tts 2>&1 | tail -1`, { stdio: 'inherit' });
  } catch {
    console.warn('edge-tts install failed, will try anyway');
  }
  try {
    execSync(`pip install ${pipOpts} kokoro-onnx huggingface_hub soundfile numpy 2>&1 | tail -3`, {
      stdio: 'inherit',
    });
  } catch {
    console.warn('kokoro-onnx install failed, will fallback to edge-tts');
  }
}

// ═══════════════════════════════════════════════════════════════
// 1 クリップの TTS を実行 → 秒数を返す
// ═══════════════════════════════════════════════════════════════
function synthesizeOne(index, text, outPath) {
  console.log(`  [${index}] Synthesizing: ${text.substring(0, 50)}...`);

  const result = execSync(
    `python3 "${TTS_HELPER}" --text ${JSON.stringify(text)} --output "${outPath}"`,
    { encoding: 'utf-8', timeout: 120_000 },
  );

  const duration = parseFloat(result.trim());
  if (isNaN(duration) || duration <= 0) {
    throw new Error(`Invalid duration for scene ${index}: ${result.trim()}`);
  }

  console.log(`  [${index}] Duration: ${duration.toFixed(2)}s`);
  return duration;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ TTS Generator ===');

  ensureDeps();

  const planPath = path.join(OUT_DIR, 'plan.json');
  const planRaw = await fs.readFile(planPath, 'utf-8');
  const plan = JSON.parse(planRaw);

  if (!plan.scenes || plan.scenes.length === 0) {
    throw new Error('plan.json has no scenes');
  }

  await fs.mkdir(AUDIO_DIR, { recursive: true });

  const timing = [];

  for (let i = 0; i < plan.scenes.length; i++) {
    const outPath = path.join(AUDIO_DIR, `${i}.wav`);
    const duration = synthesizeOne(i, plan.scenes[i].narration, outPath);
    timing.push({ index: i, file: `${i}.wav`, duration });
  }

  const timingPath = path.join(OUT_DIR, 'timing.json');
  await fs.writeFile(timingPath, JSON.stringify(timing, null, 2), 'utf-8');

  const total = timing.reduce((s, t) => s + t.duration, 0);
  console.log(`\nDone. ${timing.length} audio clips, ${total.toFixed(2)}s total`);
  console.log(`Timing saved to out/timing.json`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
