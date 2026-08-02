/**
 * VAIZ — Image Generator
 *
 * plan.json の各 scene.image_prompt を Cloudflare Workers AI
 * (@cf/black-forest-labs/flux-1-schnell) に投げて画像を生成する。
 *
 * 使い方: bun run scripts/video/images.mjs
 * 環境変数: CF_ACCOUNT_ID, CF_API_TOKEN
 * 入力: out/plan.json
 * 出力: out/img/{0..N}.png  (1080x1920 縦型)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const IMG_DIR = path.join(OUT_DIR, 'img');
const TARGET_W = 1080;
const TARGET_H = 1920;
const MAX_BACKOFF_MS = 30_000;

// ═══════════════════════════════════════════════════════════════
// Cloudflare Workers AI — Flux 1 Schnell
// ═══════════════════════════════════════════════════════════════
async function generateImage(prompt) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!accountId) throw new Error('CF_ACCOUNT_ID is not set');
  if (!token) throw new Error('CF_API_TOKEN is not set');

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      image: [],
      num_steps: 4,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CF Workers AI ${res.status}: ${body}`);
  }

  // レスポンスは image octet-stream (base64 またはバイナリ)
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('image')) {
    return new Uint8Array(await res.arrayBuffer());
  }

  // JSON レスポンスの場合 (image b64)
  const json = await res.json();
  if (json.result?.image) {
    return Uint8Array.from(atob(json.result.image), (c) => c.charCodeAt(0));
  }
  throw new Error('Unexpected response format from CF Workers AI');
}

// ═══════════════════════════════════════════════════════════════
// 画像を 1080x1920 にパディング/クロップ (canvas-free, 純 JS)
// ═══════════════════════════════════════════════════════════════
async function padToVertical(imgBytes) {
  // ffmpeg でリサイズする方が確実なので、画像はそのまま保存し
  // render.mjs 側で pad/crop する設計にする。
  // ここでは raw bytes をそのまま返す。
  return imgBytes;
}

// ═══════════════════════════════════════════════════════════════
// 指数バックオフ付き直列実行
// ═══════════════════════════════════════════════════════════════
async function generateAll(scenes) {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    let delay = 1000;
    let success = false;

    for (let attempt = 1; attempt <= 5 && !success; attempt++) {
      try {
        console.log(`  [${i}] Generating (attempt ${attempt})...`);
        const imgBytes = await generateImage(scene.image_prompt);
        const padded = await padToVertical(imgBytes);
        const outPath = path.join(IMG_DIR, `${i}.png`);
        await fs.writeFile(outPath, padded);
        results.push(outPath);
        success = true;
        console.log(`  [${i}] Saved ${outPath}`);
      } catch (err) {
        const isRateLimit =
          err.message.includes('429') ||
          err.message.includes('rate') ||
          err.message.includes('too many');

        if (!isRateLimit || attempt === 5) {
          console.error(`  [${i}] Failed: ${err.message}`);
          throw err;
        }

        console.warn(`  [${i}] Rate limited. Waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ Image Generator ===');

  const planPath = path.join(OUT_DIR, 'plan.json');
  const planRaw = await fs.readFile(planPath, 'utf-8');
  const plan = JSON.parse(planRaw);

  if (!plan.scenes || plan.scenes.length === 0) {
    throw new Error('plan.json has no scenes');
  }

  console.log(`Generating ${plan.scenes.length} images...`);
  const paths = await generateAll(plan.scenes);
  console.log(`Done. ${paths.length} images saved to out/img/`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
