/**
 * VAIZ — Image Generator
 *
 * plan.json の各 scene.image_prompt を Cloudflare Workers AI
 * (@cf/black-forest-labs/flux-1-schnell) に投げて画像を生成する。
 *
 * 使い方: bun run scripts/video/images.mjs
 * 環境変数: CF_ACCOUNT_ID, CF_API_TOKEN
 * 入力: out/plan.json
 * 出力: out/img/{0..N}.jpg  (flux は JPEG を返す。PNG が返れば .png)
 *
 * NOTE: 縦型化 (1080x1920) は render.mjs 側で行う。ここでは元画像をそのまま保存する。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const IMG_DIR = path.join(OUT_DIR, 'img');
const MODEL = '@cf/black-forest-labs/flux-1-schnell';
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;
const MAX_PROMPT_CHARS = 2048; // flux-1-schnell の入力上限

// ═══════════════════════════════════════════════════════════════
// Cloudflare Workers AI — Flux 1 Schnell
// ═══════════════════════════════════════════════════════════════
async function generateImage(prompt) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!accountId) throw new Error('CF_ACCOUNT_ID is not set');
  if (!token) throw new Error('CF_API_TOKEN is not set');

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // flux-1-schnell が受け付けるのは prompt と steps だけ。
    // 余計なフィールド (num_steps 等) を送るとスキーマ検証で弾かれる。
    body: JSON.stringify({
      prompt: prompt.substring(0, MAX_PROMPT_CHARS),
      steps: 4,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`CF Workers AI ${res.status}: ${body.substring(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  // 通常は JSON ({ result: { image: "<base64 JPEG>" } })。
  // 将来バイナリを直接返すようになっても壊れないよう両対応にしておく。
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('image')) {
    return Buffer.from(await res.arrayBuffer());
  }

  const json = await res.json();
  if (json.result?.image) return Buffer.from(json.result.image, 'base64');

  throw new Error(
    `Unexpected response from CF Workers AI: ${JSON.stringify(json).substring(0, 300)}`,
  );
}

/** マジックバイトから拡張子を決める (flux は JPEG を返す) */
function extensionFor(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return 'jpg';
}

/** すでに生成済みのシーンがあれば読み飛ばす (途中失敗からの再開用) */
async function existingImage(i) {
  for (const ext of ['jpg', 'png', 'webp']) {
    const p = path.join(IMG_DIR, `${i}.${ext}`);
    try {
      const st = await fs.stat(p);
      if (st.size > 0) return p;
    } catch {
      /* not found */
    }
  }
  return null;
}

function isRetryable(err) {
  if (err.status === 429) return true;
  if (err.status >= 500) return true;
  // fetch レベルのネットワークエラー (status なし)
  return err.status === undefined;
}

// ═══════════════════════════════════════════════════════════════
// 指数バックオフ付き直列実行
// ═══════════════════════════════════════════════════════════════
async function generateAll(scenes) {
  await fs.mkdir(IMG_DIR, { recursive: true });
  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    const cached = await existingImage(i);
    if (cached) {
      console.log(`  [${i}] Already exists, skipping (${path.basename(cached)})`);
      results.push(cached);
      continue;
    }

    let delay = 2000;
    let saved = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt++) {
      try {
        console.log(`  [${i}] Generating (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const buf = await generateImage(scenes[i].image_prompt);
        if (buf.length === 0) throw new Error('Empty image payload');

        const outPath = path.join(IMG_DIR, `${i}.${extensionFor(buf)}`);
        await fs.writeFile(outPath, buf);
        saved = outPath;
        console.log(`  [${i}] Saved ${path.basename(outPath)} (${(buf.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) {
          console.error(`  [${i}] Failed: ${err.message}`);
          throw err;
        }
        console.warn(`  [${i}] ${err.message} — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }

    results.push(saved);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ Image Generator ===');

  const plan = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'plan.json'), 'utf-8'));

  if (!plan.scenes || plan.scenes.length === 0) {
    throw new Error('plan.json has no scenes');
  }

  console.log(`Generating ${plan.scenes.length} images with ${MODEL}...`);
  const paths = await generateAll(plan.scenes);
  console.log(`Done. ${paths.length} images in out/img/`);
}

// エントリポイントとして実行されたときだけパイプラインを走らせる。
// import しただけで Cloudflare を叩き始めないようにするため
// (plan.mjs が既に採っている形に揃えてある)。
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

export { extensionFor, isRetryable };
