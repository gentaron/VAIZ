/**
 * VAIZ — Video Plan Generator
 *
 * Linear (GEN チーム) から動画ブリーフを 1 件 claim し、
 * OpenRouter 無料モデルに投げて動画プラン JSON を生成する。
 *
 * claim の対象は 2 系統ある:
 *   1. agent-ready ラベル付きの Todo Issue（本来の入口）
 *   2. 「動画がまだ付いていない動画ブリーフ」の救済（下記）
 *
 * 2 が要る理由: Todo は VAIZ 専用の待ち行列ではない。上流の Genesis Vault にも
 * Todo を漁るワークフロー (linear-write.yml) があり、そちらはラベルで絞らずに
 * 「最も古い Todo」を 1 件持っていく。ブリーフが VAIZ より先にそちらへ取られると、
 * Issue は In Progress / In Review へ移ったまま動画だけが永久に作られない。
 * Todo に居るかどうかではなく「動画が届いているか」を完了条件にすれば、
 * 取り合いに負けた分も次の実行で拾い直せる。
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
const LABEL_NAME = process.env.LINEAR_LABEL || 'agent-ready';
const MAX_ATTEMPTS = 2; // 同一モデルでの再試行回数
const MAX_TOTAL_CALLS = 12; // 全モデル合計の上限（無限に叩かないための保険）
const MAX_DISCOVERED = 6; // 動的に拾う無料モデルの数

// 救済対象にする state。Todo より先へ動かされてしまった Issue を拾う。
// Backlog は入れない — あそこは「今はやらない」と人間が置いた場所で、
// 機械が勝手に持ち出してよい棚ではない。
const RESCUE_STATES = ['In Progress', 'In Review'];

// publish.mjs が動画を届けたときに残す印。本文の頭で判定していた頃の
// 文面も残っているので、旧いコメントも完了として認める。
const DELIVERED_MARKER = '<!-- vaiz:video -->';
const LEGACY_DELIVERED_PREFIX = '動画を生成しました。';

// Genesis Vault の VE-009 が起こした動画ブリーフの印。
// gv:source は自動生成分に必ず入り、後者は手で書いたブリーフ側の言い回し。
const BRIEF_MARKERS = ['<!-- gv:source=', 'VAIZ の video-loop'];

// 無料モデルのスラッグは頻繁に入れ替わり、予告なく有料化される。
// ハードコードした一覧は必ず腐るので、実行時に OpenRouter の
// モデル一覧から「価格ゼロ」のものを拾う。
const MANUAL_MODELS = (process.env.OPENROUTER_MODELS || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

// Cloudflare Workers AI のテキストモデル（最後の砦）。
// 画像生成と同じ 1 日 10,000 neurons を食い合うので、小さいモデルを使う。
const CF_TEXT_MODEL = process.env.CF_TEXT_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';

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
/**
 * Linear GraphQL のレスポンス封筒。
 * `data` の中身はクエリごとに変わるので、ここでは封筒だけを型にする
 * （errors の扱いを取り違えないことが目的）。
 * @typedef {{ data?: any, errors?: unknown }} LinearGqlResponse
 */

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
  const json = /** @type {LinearGqlResponse} */ (await res.json());
  if (json.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/**
 * claim 判定が読む部分だけを型にする。Linear の Issue そのものではなく
 * 「この関数が触るフィールド」を書くことで、テストから最小の作り物を
 * 渡せるようにしてある。
 * @typedef {{ nodes?: Array<{ body?: string | null }> }} LinearComments
 * @typedef {{
 *   createdAt: string,
 *   description?: string | null,
 *   comments?: LinearComments
 * }} BriefLike
 *
 * claim の対象として実際に扱う Issue（GraphQL が返す形）。
 * @typedef {BriefLike & {
 *   id: string,
 *   identifier: string,
 *   title: string,
 *   state?: { id: string, name: string }
 * }} ClaimableIssue
 */

/**
 * 動画ブリーフか。上流が起こしたブリーフには必ず印が入るので、
 * 人間が書いた普通の企画を機械が持ち出さないための境界線になる。
 * @param {string | null | undefined} description
 */
function isVideoBrief(description) {
  const text = description || '';
  return BRIEF_MARKERS.some((m) => text.includes(m));
}

/**
 * publish.mjs が既に動画を届けたか。
 * state ではなくコメントで見る — state は上流にも Linear の GitHub 連携にも
 * 書き換えられるが、このコメントを書くのは VAIZ だけだから。
 * @param {{ comments?: LinearComments }} issue
 */
function hasVideoDelivered(issue) {
  return (issue.comments?.nodes || []).some((c) => {
    const body = c.body || '';
    return body.includes(DELIVERED_MARKER) || body.startsWith(LEGACY_DELIVERED_PREFIX);
  });
}

/**
 * 作成が古い順。Linear の orderBy は降順固定なのでクライアント側で並べ替える。
 * @template {{ createdAt: string }} T
 * @param {T[]} nodes
 * @returns {T[]}
 */
function oldestFirst(nodes) {
  return [...nodes].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * 救済候補から 1 件選ぶ。動画ブリーフで、まだ動画が届いていない最古のもの。
 * @template {BriefLike} T
 * @param {T[]} nodes
 * @returns {T | null}
 */
function pickRescueTarget(nodes) {
  return (
    oldestFirst(nodes).find((i) => isVideoBrief(i.description) && !hasVideoDelivered(i)) || null
  );
}

/**
 * agent-ready な Issue を 1 件 claim して In Progress へ。
 * まず Todo の最古を見て、空なら「動画が届いていないブリーフ」を救済する。
 */
async function claimIssue() {
  // チームのワークフロー state を取得
  const teamData = await gql(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) {
        nodes {
          id
          states { nodes { id name } }
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

  // agent-ready + Todo の Issue を取得
  //
  // NOTE: Linear の orderBy は PaginationOrderBy 列挙型 (createdAt / updatedAt) で、
  // 方向は指定できず常に降順。古い順が欲しいのでクライアント側で並べ替える。
  //
  // ラベルは ID を引かずに名前で直接絞る。team.labels はチームスコープの
  // ラベルしか返さないので、agent-ready がワークスペースラベルとして
  // 作られていると ID 引きでは «not found» になってしまう。
  const issuesData = await gql(
    `query($teamId: ID!, $stateId: ID!, $labelName: String!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          state: { id: { eq: $stateId } }
          labels: { some: { name: { eq: $labelName } } }
        }
        first: 50
        orderBy: createdAt
      ) {
        nodes { id identifier title description createdAt }
      }
    }`,
    { teamId: team.id, stateId: todoState.id, labelName: LABEL_NAME },
  );

  let issue = /** @type {ClaimableIssue | null} */ (oldestFirst(issuesData.issues.nodes)[0] || null);
  let origin = { id: todoState.id, name: 'Todo' };

  // Todo が空でも、取り合いに負けたブリーフが先の state に残っていることがある。
  if (!issue) {
    console.log(`No "${LABEL_NAME}" issues in Todo for team ${TEAM_KEY}. Looking for stalled briefs...`);

    const stalledData = await gql(
      `query($teamId: ID!, $labelName: String!, $states: [String!]!) {
        issues(
          filter: {
            team: { id: { eq: $teamId } }
            state: { name: { in: $states } }
            labels: { some: { name: { eq: $labelName } } }
          }
          first: 50
          orderBy: createdAt
        ) {
          nodes {
            id identifier title description createdAt
            state { id name }
            comments(first: 50) { nodes { body } }
          }
        }
      }`,
      { teamId: team.id, labelName: LABEL_NAME, states: RESCUE_STATES },
    );

    issue = pickRescueTarget(
      /** @type {ClaimableIssue[]} */ (stalledData.issues.nodes),
    );
    if (!issue) {
      console.log('No video brief is waiting for a video. Nothing to do.');
      return null;
    }

    // 元居た state を覚えておく。失敗したときここへ戻す —
    // 救済した Issue を Todo へ落とすと、上流の writer にまた食われる。
    origin = { id: issue.state?.id || inProgressState.id, name: issue.state?.name || 'In Progress' };
    console.log(
      `Rescuing ${issue.identifier} from "${origin.name}" — it has no video yet.`,
    );
  }

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
    originStateId: origin.id,
    originStateName: origin.name,
  };
}

/** 生成に失敗したら元居た state に戻して、次回の実行で再挑戦できるようにする */
async function releaseIssue(issue, reason) {
  try {
    await gql(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issue.id, stateId: issue.originStateId },
    );
    await gql(
      `mutation($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) { success }
      }`,
      {
        id: issue.id,
        body: `プラン生成に失敗したため ${issue.originStateName} に戻しました。\n\n\`\`\`\n${reason}\n\`\`\``,
      },
    );
    console.log(`Released ${issue.identifier} back to ${issue.originStateName}.`);
  } catch (err) {
    console.error(`Failed to release issue: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// OpenRouter — 無料モデルでプラン生成
// ═══════════════════════════════════════════════════════════════
/**
 * OpenRouter のモデル一覧 1 件。価格が文字列で返ることに注意
 * （"0" と 0 の両方があり得るので parseFloat して判定している）。
 * @typedef {{
 *   id: string,
 *   pricing?: { prompt?: string, completion?: string },
 *   architecture?: { modality?: string, output_modalities?: string[] },
 *   context_length?: number
 * }} OpenRouterModel
 */

/**
 * OpenRouter のチャット応答。モデル側のエラーは HTTP 200 のまま
 * `error` フィールドで返ってくることがあるので、それも型に含める。
 * @typedef {{
 *   choices?: Array<{ message?: { content?: string } }>,
 *   error?: unknown
 * }} OpenRouterChatResponse
 */

/**
 * Cloudflare Workers AI (テキスト) の応答。
 * @typedef {{ result?: { response?: string } }} CfTextResponse
 */

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

/**
 * OpenRouter のモデル一覧から、prompt / completion 単価がゼロのものを拾う。
 * この endpoint は認証不要。失敗しても致命的ではないので空配列を返す。
 */
async function discoverFreeModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = /** @type {{ data: OpenRouterModel[] }} */ (await res.json());

    const free = data.filter((m) => {
      const p = m.pricing || {};
      const zero = (v) => v !== undefined && parseFloat(v) === 0;
      if (!zero(p.prompt) || !zero(p.completion)) return false;
      // テキスト→テキストが使えるものだけ
      const mod = m.architecture?.modality || '';
      const outputs = m.architecture?.output_modalities;
      if (outputs && !outputs.includes('text')) return false;
      return mod.includes('text');
    });

    // 文脈長が長い順。プランのプロンプトは短いが、
    // 極端に小さいモデルは JSON を守れないことが多いので目安にする。
    const ids = free
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .map((m) => m.id)
      .slice(0, MAX_DISCOVERED);

    console.log(`Discovered ${free.length} free models on OpenRouter; trying: ${ids.join(', ')}`);
    return ids;
  } catch (err) {
    console.warn(`Could not fetch OpenRouter model list: ${err.message}`);
    return [];
  }
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

  const json = /** @type {OpenRouterChatResponse} */ (await res.json());
  // OpenRouter はモデル側のエラーを 200 + error フィールドで返すことがある
  if (json.error) throw new Error(`OpenRouter model error: ${JSON.stringify(json.error).substring(0, 300)}`);

  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from OpenRouter');

  return extractJson(content);
}

/**
 * 最後の砦: Cloudflare Workers AI。
 * 画像生成で使う CF の認証情報をそのまま使えるので、
 * OpenRouter の無料枠が全滅してもループは止まらない。
 */
async function callWorkersAI(brief, feedback) {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!accountId || !token) throw new Error('CF_ACCOUNT_ID / CF_API_TOKEN are not set');

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_TEXT_MODEL}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(brief, feedback) },
        ],
        max_tokens: 2000,
        temperature: 0.7,
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Workers AI ${res.status}: ${(await res.text()).substring(0, 300)}`);
  }

  const json = /** @type {CfTextResponse} */ (await res.json());
  const content = json.result?.response;
  if (!content) {
    throw new Error(`Unexpected Workers AI response: ${JSON.stringify(json).substring(0, 300)}`);
  }
  return extractJson(content);
}

/** モデルごと即座に見切るべきエラー（そのモデルでは何度やっても無駄なもの） */
function isModelDead(message) {
  // 404/403/400 = 廃止・権限なし・不正なスラッグ、429 = 無料枠の上限
  return /OpenRouter (400|401|402|403|404|429)/.test(message);
}

/** 候補モデルを順に試して、Zod 検証を通るプランが出たら返す */
async function generatePlan(brief) {
  const discovered = await discoverFreeModels();

  // 明示指定 → 無料オートルーター → 実行時に見つけた無料モデル
  const candidates = [...new Set([...MANUAL_MODELS, 'openrouter/free', ...discovered])];
  console.log(`Model candidates (${candidates.length}): ${candidates.join(', ')}`);

  let feedback = null;
  let lastError;
  let calls = 0;

  for (const model of candidates) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (calls >= MAX_TOTAL_CALLS) {
        console.warn(`Reached the ${MAX_TOTAL_CALLS}-call budget; giving up on OpenRouter.`);
        break;
      }
      calls++;

      try {
        console.log(`[${calls}] ${model} (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const plan = PlanSchema.parse(await callOpenRouter(model, brief, feedback));
        console.log(`Plan validated (model: ${model}).`);
        return plan;
      } catch (err) {
        lastError = err;
        feedback = err.message.substring(0, 500);
        console.error(`  Failed: ${feedback}`);

        if (isModelDead(err.message)) {
          console.log('  Model unavailable for this key — trying next candidate.');
          break;
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        }
      }
    }
    if (calls >= MAX_TOTAL_CALLS) break;
  }

  // OpenRouter が全滅した場合のみ Cloudflare へ
  if (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN) {
    console.warn('\nAll OpenRouter candidates failed. Falling back to Cloudflare Workers AI.');
    console.warn(
      `NOTE: ${CF_TEXT_MODEL} は画像生成と同じ 1 日 10,000 neurons を消費します。`,
    );
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        console.log(`Workers AI ${CF_TEXT_MODEL} (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        const plan = PlanSchema.parse(await callWorkersAI(brief, feedback));
        console.log(`Plan validated (model: ${CF_TEXT_MODEL}).`);
        return plan;
      } catch (err) {
        lastError = err;
        feedback = err.message.substring(0, 500);
        console.error(`  Failed: ${feedback}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
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

// 直接実行されたときだけ走らせる（テストから import できるように）
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

export {
  buildUserPrompt,
  discoverFreeModels,
  extractJson,
  hasVideoDelivered,
  isModelDead,
  isVideoBrief,
  oldestFirst,
  pickRescueTarget,
  PlanSchema,
};
