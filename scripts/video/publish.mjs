/**
 * VAIZ — Publisher
 *
 * final.mp4 を GitHub Release に添付し、URL を元の Linear Issue に
 * コメントしてステータスを In Review に変更する。
 * 自動公開はしない（人間の確認を挟む）。
 *
 * 使い方: bun run scripts/video/publish.mjs
 * 環境変数: GITHUB_TOKEN (自動設定), LINEAR_API_KEY
 * 入力: out/plan.json, out/final.mp4
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
// Linear helpers (publish.mjs 専用 — 既存 linear-sync.mjs を維持)
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
// GitHub Release 作成
// ═══════════════════════════════════════════════════════════════
async function createRelease(tag, title, filePath, fileName) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');

  // GITHUB_REPOSITORY は GitHub Actions で自動設定される
  const repo = process.env.GITHUB_REPOSITORY || 'gentaron/VAIZ';
  const apiBase = `https://api.github.com/repos/${repo}`;

  // 1. Release を作成 (draft=true で自動公開しない)
  console.log(`Creating GitHub Release: ${tag}`);
  const releaseRes = await fetch(`${apiBase}/releases`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag_name: tag,
      name: title,
      draft: true,
      generate_release_notes: false,
    }),
  });

  if (!releaseRes.ok) {
    const body = await releaseRes.text();
    throw new Error(`GitHub Release API ${releaseRes.status}: ${body}`);
  }

  const release = await releaseRes.json();
  console.log(`Release created: ${release.html_url} (draft)`);

  // 2. アセットをアップロード
  console.log(`Uploading ${fileName}...`);
  const fileBuffer = await fs.readFile(filePath);
  const uploadRes = await fetch(release.upload_url.replace('{?name,label}', `?name=${fileName}`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  const asset = await uploadRes.json();
  console.log(`Asset uploaded: ${asset.browser_download_url}`);
  return { releaseUrl: release.html_url, assetUrl: asset.browser_download_url };
}

// ═══════════════════════════════════════════════════════════════
// Linear Issue にコメント + In Review へ
// ═══════════════════════════════════════════════════════════════
async function reportToLinear(issueId, comment) {
  // In Review の state ID を取得
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
  if (!reviewState) throw new Error('In Review state not found');

  // コメント
  await gql(
    `mutation($id: String!, $body: String!) {
      commentCreate(input: { issueId: $id, body: $body }) { success }
    }`,
    { id: issueId, body: comment },
  );

  // ステータス変更
  await gql(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issueId, stateId: reviewState.id },
  );

  console.log(`Linear issue updated → In Review`);
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ Publisher ===');

  const plan = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'plan.json'), 'utf-8'));
  const finalPath = path.join(OUT_DIR, 'final.mp4');

  // ファイル存在確認
  try {
    await fs.access(finalPath);
  } catch {
    throw new Error('final.mp4 not found. Run render.mjs first.');
  }

  const issueId = plan._issue?.id;
  if (!issueId) throw new Error('No issue ID in plan.json');

  // タグ名を生成 (例: video-2026-08-02-001)
  const date = new Date().toISOString().split('T')[0];
  const safeTitle = plan.title
    .replace(/[^a-zA-Z0-9\-_ あ-んア-ヶ亜-熙]/g, '')
    .substring(0, 40)
    .trim();
  const tag = `video-${date}`;
  const releaseName = `${safeTitle} (${date})`;
  const fileName = `video-${date}.mp4`;

  // GitHub Release にアップロード
  const { releaseUrl, assetUrl } = await createRelease(
    tag, releaseName, finalPath, fileName,
  );

  // Linear に結果を報告
  const hashtags = plan.hashtags?.join(' ') || '';
  const comment = [
    `Video generated successfully.`,
    ``,
    `Title: ${plan.title}`,
    `Hook: ${plan.hook}`,
    `Scenes: ${plan.scenes.length}`,
    ``,
    `Preview (Draft Release): ${releaseUrl}`,
    `Download: ${assetUrl}`,
    ``,
    `Hashtags: ${hashtags}`,
  ].join('\n');

  await reportToLinear(issueId, comment);

  console.log(`\n=== Published ===`);
  console.log(`Release: ${releaseUrl}`);
  console.log(`Download: ${assetUrl}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
