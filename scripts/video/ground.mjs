/**
 * VAIZ — ブリーフの裏取り（ナレッジベースから）
 *
 * 動画のナレーションは無料モデルが書く。モデルは数字や固有名詞を「それらしく」
 * 作るので、ブリーフに関係する事実を先に渡しておく。
 * 事実の出どころはハブ (gentaron/infocollect) のナレッジベースで、そこには
 * 毎日の AI ニュース・論文に加えて、ネットワークの他ノードが出した結果
 * （数理物理ラボの検証済みの数、QAIZ の相場の地形）も入っている。
 *
 * - 認証不要の静的ファイル (manifest.json + 月ごとの JSONL) を読むだけ
 * - 取れなければ何も足さない（fail-soft）。動画の生成は止めない
 * - VAIZ_KB=off で無効、VAIZ_KB_URL で読み先を変更（ローカルのフォルダも可）
 */

import fs from 'node:fs/promises';

export const KB_URL = process.env.VAIZ_KB_URL || 'https://raw.githubusercontent.com/gentaron/infocollect/HEAD/docs/kb';
const MAX_FACTS = 4;
const TIMEOUT_MS = 8000;

/** 日本語は文字 2-gram、英数字は単語で切る。ストップワード無しでも十分に効く粒度。 */
export function terms(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9][a-z0-9.+-]{1,}/g) || []) out.add(w);
  for (const run of s.match(/[぀-ヿ㐀-鿿]+/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** ブリーフと重なる語の数で並べる。ネットワークの検証済み・観測値を少しだけ優先する。 */
export function rankFacts(brief, docs, { limit = MAX_FACTS, minOverlap = 3 } = {}) {
  const want = terms(brief);
  const scored = [];
  for (const d of docs) {
    if (!d?.url || !/^https:\/\//.test(d.url) || !d.title) continue;
    const have = terms(`${d.title} ${d.titleJa || ''} ${d.summary || ''}`);
    let overlap = 0;
    for (const t of have) if (want.has(t)) overlap++;
    if (overlap < minOverlap) continue;
    const tags = d.tags || [];
    const trust = tags.includes('verified') ? 1.5 : tags.includes('observed') ? 1.2 : 1;
    scored.push({ d, score: overlap * trust });
  }
  scored.sort((a, b) => b.score - a.score || String(b.d.date).localeCompare(String(a.d.date)));
  const seen = new Set();
  return scored
    .filter(({ d }) => !seen.has(d.url) && seen.add(d.url))
    .slice(0, limit)
    .map(({ d }) => ({ title: d.titleJa || d.title, url: d.url, summary: d.summary || '', source: d.source || '', date: d.date || '' }));
}

/** ブリーフの末尾に足す参考ブロック。事実が無ければ空文字。 */
export function factsBlock(facts) {
  if (!facts.length) return '';
  const lines = facts.map((f) => `- ${f.title}${f.summary ? ` — ${f.summary.slice(0, 160)}` : ''}（${f.source || '出典'}: ${f.url}）`);
  return [
    '',
    '---',
    '参考（ナレッジベース）: 数字・日付・固有名詞を使うなら、ここにあるものだけを使う。無ければ数字を出さない。',
    ...lines,
  ].join('\n');
}

async function read(url, as = 'json') {
  if (!/^https?:\/\//.test(url)) {
    const text = await fs.readFile(url, 'utf-8');
    return as === 'json' ? JSON.parse(text) : text;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

export async function loadKb(kbUrl = KB_URL, months = 2) {
  const manifest = await read(`${kbUrl}/manifest.json`);
  const keys = (manifest.shards || []).map((s) => s.key).sort().slice(-months);
  const docs = [];
  for (const key of keys) {
    const text = await read(`${kbUrl}/shards/${key}.jsonl`, 'text');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        docs.push(JSON.parse(line));
      } catch {
        // 壊れた 1 行は飛ばす
      }
    }
  }
  return docs;
}

/** ブリーフに裏取りを足して返す。何があっても例外を投げない。 */
export async function groundBrief(brief, { kbUrl = KB_URL, enabled = process.env.VAIZ_KB !== 'off' } = {}) {
  if (!enabled || !brief) return { brief, facts: [] };
  try {
    const facts = rankFacts(brief, await loadKb(kbUrl));
    return { brief: brief + factsBlock(facts), facts };
  } catch (err) {
    console.warn(`KB grounding skipped: ${err.message}`);
    return { brief, facts: [] };
  }
}
