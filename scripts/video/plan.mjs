/**
 * VAIZ — Video Plan Generator
 *
 * Linear (GEN チーム) から agent-ready ラベル付き Todo Issue を 1 件 claim し、
 * OpenRouter 無料モデルに投げて動画プラン JSON を生成する。
 *
 * 使い方: bun run scripts/video/plan.mjs
 * 環境変数: LINEAR_API_KEY, OPENROUTER_API_KEY
 * 出力: out/plan.json
 */

import { z } from 'zod';
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', '..', 'out');
const TEAM_KEY = process.env.LINEAR_TEAM_KEY || 'GEN';
const MAX_RETRIES = 1;

// ═══════════════════════════════════════════════════════════════
// Zod Schema — 動画プラン構造
// ═══════════════════════════════════════════════════════════════
const SceneSchema = z.object({
  narration: z.string().min(5, 'narration must be >= 5 chars'),
  image_prompt: z.string().min(10, 'image_prompt must be >= 10 chars'),
  seconds: z.number().min(3).max(15),
});

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
      return total >= 45 && total <= 60;
    },
    { message: 'Total scene duration must be 45–60 seconds' },
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
  if (!agentReadyLabel) throw new Error('Label "agent-ready" not found in team GEN');

  // agent-ready + Todo の Issue を取得
  const issuesData = await gql(
    `query($teamId: ID!, $stateId: ID!, $labelId: ID!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          state: { id: { eq: $stateId } }
          labels: { some: { id: { eq: $labelId } } }
        }
        first: 20
        orderBy: { createdAt: ASC }
      ) {
        nodes { id identifier title description createdAt }
      }
    }`,
    { teamId: team.id, stateId: todoState.id, labelId: agentReadyLabel.id },
  );

  const nodes = issuesData.issues.nodes;
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
  };
}

// ═══════════════════════════════════════════════════════════════
// OpenRouter — 無料モデルでプラン生成
// ═══════════════════════════════════════════════════════════════
async function generatePlan(brief) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');

  const systemPrompt = `You are a video script planner. You output ONLY valid JSON. No markdown, no preamble, no explanation.
Generate a vertical short video plan (1080x1920) in Japanese.
Requirements:
- 6 to 8 scenes
- Total duration 45-60 seconds
- Each scene: narration (spoken text, natural Japanese), image_prompt (English, detailed for image generation), seconds (3-15)
- A catchy hook line
- 3-10 hashtags for social media`;

  const userPrompt = `Based on this brief, create a video plan:

---
${brief}
---

Output JSON exactly matching this structure (no other text):
{"title":"...","hook":"...","scenes":[{"narration":"...","image_prompt":"...","seconds":N}],"hashtags":["..."]}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat-v3-0324:free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${body}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from OpenRouter');

  // JSON を抽出（コードブロックで囲まれている場合も対応）
  const jsonStr =
    content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() || content;
  return JSON.parse(jsonStr);
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

  // Step 2: OpenRouter でプラン生成（Zod 検証、1回リトライ）
  let plan;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      console.log(`Generating plan (attempt ${attempt}/${MAX_RETRIES + 1})...`);
      const raw = await generatePlan(issue.description);
      plan = PlanSchema.parse(raw);
      console.log('Plan validated successfully.');
      break;
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt <= MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  if (!plan) {
    console.error(`All attempts failed. Last error: ${lastError?.message}`);
    process.exit(1);
  }

  // Step 3: out/plan.json に保存
  await fs.mkdir(OUT_DIR, { recursive: true });
  const output = { ...plan, _issue: { id: issue.id, identifier: issue.identifier } };
  const planPath = path.join(OUT_DIR, 'plan.json');
  await fs.writeFile(planPath, JSON.stringify(output, null, 2), 'utf-8');

  const totalSec = plan.scenes.reduce((s, c) => s + c.seconds, 0);
  console.log(`Saved plan: ${plan.scenes.length} scenes, ${totalSec}s total`);
  console.log(`Title: ${plan.title}`);
  console.log(`Hook: ${plan.hook}`);
  plan.scenes.forEach((s, i) => {
    console.log(`  Scene ${i}: ${s.seconds}s — ${s.narration.substring(0, 40)}...`);
  });

  // GitHub Actions outputs
  setOutput({
    found: 'true',
    issue_id: issue.id,
    issue_key: issue.identifier,
    video_title: plan.title,
    scene_count: String(plan.scenes.length),
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
