/**
 * VAIZ — Failure Notifier
 *
 * ワークフローが途中で落ちたとき、claim 済みの Linear Issue に
 * 実行ログへのリンクをコメントする。
 *
 * Issue は In Progress のままにしておく（自動で Todo に戻すと、
 * 原因が直っていないのに毎晩リトライして無料枠を食い潰すため）。
 *
 * 使い方: bun run scripts/video/notify-failure.mjs
 * 環境変数: LINEAR_API_KEY, RUN_URL, (任意) FAILED_STEP
 * 入力: out/claim.json — 無ければ何もせず正常終了する
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '..', 'out');

async function main() {
  let claim;
  try {
    claim = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'claim.json'), 'utf-8'));
  } catch {
    console.log('out/claim.json not found — Issue を掴む前に失敗したので通知をスキップします。');
    return;
  }

  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    console.log('LINEAR_API_KEY not set — skipping notification.');
    return;
  }

  const body = [
    '動画生成ワークフローが失敗しました。',
    '',
    process.env.FAILED_STEP ? `失敗したジョブ: ${process.env.FAILED_STEP}` : null,
    `実行ログ: ${process.env.RUN_URL || '(不明)'}`,
    '',
    'このIssueは In Progress のままにしてあります。',
    '原因を直したら手動で Run workflow するか、Todo に戻してください。',
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({
      query: `mutation($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) { success }
      }`,
      variables: { id: claim.id, body },
    }),
  });

  const text = await res.text();
  console.log(`Linear notify (${claim.identifier}): ${res.status} ${text.substring(0, 200)}`);
}

// 通知の失敗でジョブをさらに壊さない
main().catch((err) => {
  console.error('Notification failed (ignored):', err.message || err);
});
