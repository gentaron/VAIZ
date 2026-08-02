/**
 * VAIZ — Video Plan Generator
 *
 * Linear (GEN チーム) から agent-ready ラベル付き Todo Issue を 1 件 claim し、
 * OpenRouter 無料モデルに投げて動画プラン JSON を生成する。
 *
 * 使い方: bun run scripts/video/plan.mjs
 * 環境変数: LINEAR_API_KEY, OPENROUTER_API_KEY
 *           (任意) LINEAR_TEAM_KEY, OPENROUTER_MODELS
 * 出力: out/claim.json (claim 直後), out/plan.json (生成成功時)
 */

import { z } from 'zod';
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '..', 'out');
const TEAM_KEY = process.env.LINEAR_TEAM_KEY || 'GEN';
const MAX_ATTEMPTS = 3;

// 無料モデルは頻繁に入れ替わるので、順に試すフォールバック列にしておく。
const DEFAULT_MODELS = [
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'google/gemma-3-27b-it:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
];
const MODELS = (process.env.OPENROUTER_MODELS || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL_CANDIDATES = MODELS.length > 0 ? MODELS : DEFAULT_MODELS;

// ═══════════════════════════════════════════════════════════════
// Zod Schema — 動画プラン構造
// ═══════════════════════════════════════════════════════════════
const SceneSchema = z.object({
  narration: z.string().min(5, 'narration must be >= 5 chars'),
  image_prompt: z.string().min(10, 'image_prompt must be >= 10 chars'),
  seconds: z.number().min(3).max(15),
});

// seconds はあくまで目安（実尺は tts.mjs の実測値で決まる）なので、
// ハード制約は緩めに取り、45〜60s から外れたときは警告に留める。
const TARGET_MIN = 45;
const TARGET_MAX = 60;
const HARD_MIN = 35;
const HARD_MAX = 80;

const PlanSchema = z
  .object({
    title: z.string().min(1).max(100),
    hook: z.string().min(1),
    scenes: z.array(SceneSchema).min(6).max(8),
    hashtags: z.array(z.string().min(1)).min(3).max(10),
  })
  .refine(
    (d) => {
      const total = d.scenes.reduce((s, c) => s + c.seconds, 0);
      return total >= HARD_MIN && total <= HARD_MAX;
    },
    { message: `Total scene duration must be ${HARD_MIN}-${HARD_MAX} seconds` },
  );

// ═══════════════════════════════════════════════════════════════
// Linear GraphQL helpers
// ═══════════════════════════════════════════════════════════════
const LINEAR_API = 'https://api.linear.app/graphql';

async function gql(query, variables = {}) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('LINEAR_API_KEY is not set');

  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: key,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/** agent-ready ラベル付きの最も古い Todo Issue を 1 件 claim して In Progress へ */
async function claimIssue() {
  // チーム情報 + ラベル一覧を取得
  const teamData = await gql(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) {
        nodes {
          id
          states { nodes { id name } }
          labels { nodes { id name } }
        }
      }
    }`,
    { key: TEAM_KEY },
  );

  const team = teamData.teams.nodes[0];
  if (!team) throw new Error(`Team "${TEAM_KEY}" not found`);

  const todoState = team.states.nodes.find((s) => s.name === 'Todo');
  const inProgressState = team.states.nodes.find((s) => s.name === 'In Progress');
  if (!todoState) throw new Error('Todo state not found');
  if (!inProgressState) throw new Error('In Progress state not found');

  const agentReadyLabel = team.labels.nodes.find((l) => l.name === 'agent-ready');
  if (!agentReadyLabel) throw new Error(`Label "agent-ready" not found in team ${TEAM_KEY}`);

  // agent-ready + Todo の Issue を取得
  //
  // NOTE: Linear の orderBy は PaginationOrderBy 列挙型 (createdAt / updatedAt) で、
  // 方向は指定できず常に降順。古い順が欲しいのでクライアント側で並べ替える。
  const issuesData = await gql(
    `query($teamId: ID!, $stateId: ID!, $labelId: ID!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          state: { id: { eq: $stateId } }
          labels: { some: { id: { eq: $labelId } } }
        }
        first: 50
        orderBy: createdAt
      ) {
        nodes { id identifier title description createdAt }
      }
    }`,
    { teamId: team.id, stateId: todoState.id, labelId: agentReadyLabel.id },
  );

  const nodes = [...issuesData.issues.nodes].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  );
  if (nodes.length === 0) {
    console.log('No agent-ready issues in Todo. Nothing to do.');
    return null;
  }

  const issue = nodes[0];

  // In Progress へ移行
  await gql(
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    { id: issue.id, stateId: inProgressState.id },
  );

  console.log(`Claimed ${issue.identifier}: ${issue.title}`);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description || '',
    todoStateId: todoState.id,
  };
}

/** 生成に失敗したら Todo に戻して、次回の実行で再挑戦できるようにする */
async function releaseIssue(issue, reason) {
  try {
    await gql(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issue.id, stateId: issue.todoStateId },
    );
    await gql(
      `mutation($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) { success }
      }`,
      {
        id: issue.id,
        body: `プラン生成に失敗したため Todo に戻しました。\n\n\`\`\`\n${reason}\n\`\`\``,
      },
    );
    console.log(`Released ${issue.identifier} back to Todo.`);
  } catch (err) {
    console.error(`Failed to release issue: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// OpenRouter — 無料モデルでプラン生成
// ═══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are a video script planner. You output ONLY valid JSON. No markdown, no preamble, no explanation.
Generate a vertical short video plan (1080x1920) in Japanese.
Requirements:
- Exactly 6 to 8 scenes
- Total duration ${TARGET_MIN}-${TARGET_MAX} seconds (sum of every scene's "seconds")
- Each scene: narration (spoken text, natural Japanese, 1-2 sentences), image_prompt (English, detailed, no text/letters in the image), seconds (3-15)
- A catchy hook line in Japanese
- 3-10 hashtags for social media`;

function buildUserPrompt(brief, feedback) {
  const base = `Based on this brief, create a video plan:

---
${brief}
---

Output JSON exactly matching this structure (no other text):
{"title":"...","hook":"...","scenes":[{"narration":"...","image_prompt":"...","seconds":N}],"hashtags":["..."]}`;

  if (!feedback) return base;
  return `${base}

The previous attempt was rejected for this reason. Fix it and output valid JSON only:
${feedback}`;
}

/** ```json フェンスや前後の地の文があっても JSON 本体を取り出す */
function extractJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim();
  const candidate = fenced || content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in response: ${content.substring(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function callOpenRouter(model, brief, feedback) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://github.com/gentaron/VAIZ',
      'X-Title': 'VAIZ Video Loop',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(brief, feedback) },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.substring(0, 300)}`);
  }

  const json = await res.json();
  // OpenRouter はモデル側のエラーを 200 + error フィールドで返すことがある
  if (json.error) throw new Error(`OpenRouter model error: ${JSON.stringify(json.error).substring(0, 300)}`);

  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from OpenRouter');

  return extractJson(content);
}

/** モデル列 × リトライで、Zod 検証を通るプランが出るまで試す */
async function generatePlan(brief) {
  let feedback = null;
  let lastError;

  for (const model of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`Generating plan with ${model} (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const raw = await callOpenRouter(model, brief, feedback);
        const plan = PlanSchema.parse(raw);
        console.log(`Plan validated (model: ${model}).`);
        return plan;
      } catch (err) {
        lastError = err;
        feedback = err.message.substring(0, 500);
        console.error(`  Failed: ${feedback}`);

        // モデル自体が使えない (404 / 権限 / 廃止) なら次のモデルへ
        if (/OpenRouter (400|404|403)/.test(err.message)) {
          console.log('  Model unavailable, trying next candidate.');
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          const delay = 2 ** attempt * 1000;
          console.log(`  Retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  }

  throw new Error(`All models/attempts failed. Last error: ${lastError?.message}`);
}

// ═══════════════════════════════════════════════════════════════
// GitHub Actions output helper
// ═══════════════════════════════════════════════════════════════
function setOutput(pairs) {
  const lines = Object.entries(pairs)
    .map(([k, v]) => `${k}=${String(v ?? '')}`)
    .join('\n');
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${lines}\n`);
  else console.log(lines);
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('=== VAIZ Video Plan Generator ===');

  // Step 1: Linear から Issue を claim
  const issue = await claimIssue();
  if (!issue) {
    setOutput({ found: 'false' });
    console.log('Exiting: no issues to process.');
    return;
  }

  // claim した事実を先に残しておく。プラン生成でコケても
  // ワークフローの失敗通知が Issue を特定できるようにするため。
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUT_DIR, 'claim.json'),
    JSON.stringify({ id: issue.id, identifier: issue.identifier, title: issue.title }, null, 2),
    'utf-8',
  );
  setOutput({ found: 'true', issue_id: issue.id, issue_key: issue.identifier });

  // Step 2: OpenRouter でプラン生成（Zod 検証、モデル間フォールバック）
  let plan;
  try {
    plan = await generatePlan(issue.description || issue.title);
  } catch (err) {
    console.error(err.message);
    await releaseIssue(issue, err.message);
    process.exit(1);
  }

  // Step 3: out/plan.json に保存
  const output = { ...plan, _issue: { id: issue.id, identifier: issue.identifier } };
  const planPath = path.join(OUT_DIR, 'plan.json');
  await fs.writeFile(planPath, JSON.stringify(output, null, 2), 'utf-8');

  const totalSec = plan.scenes.reduce((s, c) => s + c.seconds, 0);
  if (totalSec < TARGET_MIN || totalSec > TARGET_MAX) {
    console.warn(
      `Warning: planned duration ${totalSec}s is outside the ${TARGET_MIN}-${TARGET_MAX}s target ` +
        '(実尺は TTS の実測値で決まるので、これは目安のずれです)',
    );
  }
  console.log(`Saved plan: ${plan.scenes.length} scenes, ${totalSec}s total`);
  console.log(`Title: ${plan.title}`);
  console.log(`Hook: ${plan.hook}`);
  plan.scenes.forEach((s, i) => {
    console.log(`  Scene ${i}: ${s.seconds}s — ${s.narration.substring(0, 40)}...`);
  });

  setOutput({
    video_title: plan.title,
    scene_count: String(plan.scenes.length),
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
