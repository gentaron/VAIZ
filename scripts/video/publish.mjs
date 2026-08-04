/**
 * VAIZ — Publisher
 *
 * final.mp4 を GitHub Release (draft) に添付し、URL を元の Linear Issue に
 * コメントしてステータスを In Review に変更する。
 * 自動公開はしない（人間の確認を挟む）。
 *
 * 使い方: bun run scripts/video/publish.mjs
 * 環境変数: GITHUB_TOKEN (Actions が自動設定), LINEAR_API_KEY
 *           (任意) GITHUB_REPOSITORY, LINEAR_TEAM_KEY
 * 入力: out/plan.json (または out/claim.json), out/final.mp4
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT_DIR, 'out');
const TEAM_KEY = process.env.LINEAR_TEAM_KEY || 'GEN';
const LINEAR_API = 'https://api.linear.app/graphql';

// ═══════════════════════════════════════════════════════════════
// Linear helpers
// ═══════════════════════════════════════════════════════════════
async function gql(query, variables = {}) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY is not set');

  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ═══════════════════════════════════════════════════════════════
// Linear に動画ファイル本体をアップロード
//
// draft release は書き込み権限のある人にしか見えず、Tags にも出ない。
// リンクだけ渡しても踏めないことがあるので、実体を Linear にも置いて
// Issue 上でそのまま再生できるようにする。
//
// 3 段構え:
//   1. fileUpload ミューテーションで署名付き URL を発行
//   2. その URL に PUT で生バイトを送る (Google Cloud Storage 直送)
//   3. attachmentCreate で assetUrl を Issue に紐付ける
//
// 署名付き URL の有効期限は 60 秒。発行と PUT の間に他の API 呼び出しを
// 挟むと期限切れになるので、この関数の中で一気にやりきる。
// ═══════════════════════════════════════════════════════════════
async function uploadFileToLinear(filePath, fileName, contentType) {
  const bytes = await fs.readFile(filePath);

  console.log(`Uploading ${fileName} to Linear (${(bytes.length / 1024 / 1024).toFixed(1)}MB)...`);

  const data = await gql(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile {
          assetUrl
          uploadUrl
          headers { key value }
        }
      }
    }`,
    { contentType, filename: fileName, size: bytes.length },
  );

  const uploadFile = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !uploadFile) {
    throw new Error('Linear fileUpload did not return an upload target');
  }

  // 署名対象のヘッダを 1 つでも欠くと 403 になるので、返ってきたものは
  // そのまま全部付けて送る。
  // ここで素のオブジェクトを使うと 'Content-Type' と 'content-type' が
  // 別キーになり content-type が二重に飛ぶ。Headers なら正規化される。
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  for (const h of uploadFile.headers || []) headers.set(h.key, h.value);

  const res = await fetch(uploadFile.uploadUrl, { method: 'PUT', headers, body: bytes });
  if (!res.ok) {
    throw new Error(`Linear upload PUT ${res.status}: ${(await res.text()).substring(0, 300)}`);
  }

  console.log(`Uploaded to Linear: ${uploadFile.assetUrl}`);
  return uploadFile.assetUrl;
}

/** アップロード済みの assetUrl を Issue の添付として登録する */
async function attachToLinear(issueId, assetUrl, title, subtitle) {
  await gql(
    `mutation($issueId: String!, $url: String!, $title: String!, $subtitle: String) {
      attachmentCreate(input: {
        issueId: $issueId, url: $url, title: $title, subtitle: $subtitle
      }) { success }
    }`,
    { issueId, url: assetUrl, title, subtitle: subtitle || null },
  );
  console.log('Attached to Linear issue.');
}

// ═══════════════════════════════════════════════════════════════
// GitHub Release 作成
// ═══════════════════════════════════════════════════════════════
function ghHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

/** タグが衝突したら -2, -3 … と後ろに付けて確保する */
async function createRelease(apiBase, token, baseTag, title) {
  for (let n = 1; n <= 20; n++) {
    const tag = n === 1 ? baseTag : `${baseTag}-${n}`;
    const res = await fetch(`${apiBase}/releases`, {
      method: 'POST',
      headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        tag_name: tag,
        name: title,
        draft: true, // 人間が確認するまで公開しない
        generate_release_notes: false,
      }),
    });

    if (res.ok) {
      const release = await res.json();
      console.log(`Release created: ${release.html_url} (draft, tag=${tag})`);
      return release;
    }

    const body = await res.text();
    if (res.status === 422 && body.includes('already_exists')) {
      console.log(`Tag ${tag} already exists, trying next...`);
      continue;
    }
    throw new Error(`GitHub Release API ${res.status}: ${body.substring(0, 400)}`);
  }
  throw new Error(`Could not find a free release tag starting from ${baseTag}`);
}

async function uploadAsset(release, token, filePath, fileName) {
  console.log(`Uploading ${fileName}...`);
  const fileBuffer = await fs.readFile(filePath);
  const uploadUrl = release.upload_url.replace(
    /\{\?[^}]*\}$/,
    `?name=${encodeURIComponent(fileName)}`,
  );

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: ghHeaders(token, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileBuffer.length),
    }),
    body: fileBuffer,
  });

  if (!res.ok) {
    throw new Error(`Asset upload ${res.status}: ${(await res.text()).substring(0, 400)}`);
  }

  const asset = await res.json();
  console.log(`Asset uploaded: ${asset.browser_download_url}`);
  return asset;
}

// ═══════════════════════════════════════════════════════════════
// Linear Issue にコメント + In Review へ
// ═══════════════════════════════════════════════════════════════
async function reportToLinear(issueId, comment) {
  const data = await gql(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) {
        nodes { states { nodes { id name } } }
      }
    }`,
    { key: TEAM_KEY },
  );

  const states = data.teams.nodes[0]?.states.nodes;
  const reviewState = states?.find((s) => s.name === 'In Review');

  await gql(
    `mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) { success }
    }`,
    { id: issueId, body: comment },
  );

  // コメントは通ったのに state 名が違うだけで落とすのはもったいないので警告に留める
  if (!reviewState) {
    console.warn(`WARNING: "In Review" state not found in team ${TEAM_KEY}. Comment posted only.`);
    return;
  }

  await gql(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId: reviewState.id },
  );
  console.log('Linear issue updated → In Review');
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ Publisher ===');

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');

  const plan = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'plan.json'), 'utf-8'));
  const finalPath = path.join(OUT_DIR, 'final.mp4');

  try {
    await fs.access(finalPath);
  } catch {
    throw new Error('final.mp4 not found. Run render.mjs first.');
  }

  const issueId = plan._issue?.id;
  const identifier = plan._issue?.identifier || 'unknown';
  if (!issueId) throw new Error('No issue ID in plan.json');

  const repo = process.env.GITHUB_REPOSITORY || 'gentaron/VAIZ';
  const apiBase = `https://api.github.com/repos/${repo}`;
  const date = new Date().toISOString().split('T')[0];

  // タグは Issue 識別子込みにして、同じ日に複数回回しても衝突しにくくする
  const baseTag = `video-${date}-${identifier}`;
  const releaseName = `${plan.title} (${identifier} / ${date})`;
  const fileName = `${identifier}-${date}.mp4`;

  const release = await createRelease(apiBase, token, baseTag, releaseName);
  const asset = await uploadAsset(release, token, finalPath, fileName);

  // 動画本体を Linear にも上げておく。Release は既にあるので、
  // ここが落ちても警告だけ出して続行する。
  let linearAssetUrl = null;
  try {
    linearAssetUrl = await uploadFileToLinear(finalPath, fileName, 'video/mp4');
    await attachToLinear(
      issueId,
      linearAssetUrl,
      plan.title || fileName,
      `${plan.scenes.length} scenes · ${date}`,
    );
  } catch (err) {
    console.warn(`Linear upload failed (continuing): ${err.message}`);
  }

  const sizeMb = ((await fs.stat(finalPath)).size / 1024 / 1024).toFixed(1);
  const comment = [
    '動画を生成しました。内容を確認してから公開してください。',
    '',
    `**${plan.title}**`,
    `フック: ${plan.hook}`,
    `シーン数: ${plan.scenes.length} / ファイルサイズ: ${sizeMb}MB`,
    '',
    // Linear 上の実体。ここからならアクセス権に関係なく再生できる
    linearAssetUrl
      ? `[${fileName}](${linearAssetUrl})`
      : '_Linear へのアップロードに失敗しました。下の Release から取得してください。_',
    '',
    `Draft Release: ${release.html_url}`,
    `Download: ${asset.browser_download_url}`,
    '',
    `ハッシュタグ: ${plan.hashtags?.join(' ') || '—'}`,
    '',
    '_draft release なので、リンクを開くにはリポジトリへのアクセス権が必要です。_',
  ].join('\n');

  await reportToLinear(issueId, comment);

  console.log('\n=== Published ===');
  console.log(`Release: ${release.html_url}`);
  console.log(`Download: ${asset.browser_download_url}`);
  if (linearAssetUrl) console.log(`Linear asset: ${linearAssetUrl}`);
}

// エントリポイントとして実行されたときだけ公開処理を走らせる。
// import しただけで GitHub Release を作らないようにするため。
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
  });
}

export { ghHeaders };
