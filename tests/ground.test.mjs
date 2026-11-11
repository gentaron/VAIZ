import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { factsBlock, groundBrief, rankFacts, terms } from '../scripts/video/ground.mjs';

// 裏取りは「足すかもしれない」段。何が起きても動画の生成を止めてはいけないし、
// 関係の無いニュースを混ぜてナレーションを脱線させてもいけない。

const docs = [
  { title: 'Lab: 論文の表の先: 8頂点・5次元コスモヘドロンの面の数', url: 'https://github.com/x/lab', summary: '頂点 6704', tags: ['network', 'verified'], source: 'Network · Lab', date: '2026-11-11' },
  { title: 'New GPU released', url: 'https://example.com/gpu', summary: 'faster', date: '2026-11-11' },
  { title: 'コスモヘドロンの解説', url: 'http://insecure.example.com', date: '2026-11-11' },
];

describe('rankFacts', () => {
  test('ブリーフに重なる事実だけを拾い、http は捨てる', () => {
    const facts = rankFacts('高次元のコスモヘドロンの面の数を60秒で紹介する', docs);
    expect(facts.map((f) => f.url)).toEqual(['https://github.com/x/lab']);
  });

  test('重なりが薄ければ何も足さない', () => {
    expect(rankFacts('猫と散歩', docs)).toEqual([]);
  });

  test('日本語は 2-gram、英数字は単語', () => {
    expect([...terms('AI動画 GPT-5')].sort()).toEqual(['ai', 'gpt-5', '動画'].sort());
  });
});

describe('groundBrief', () => {
  test('ローカルの KB を読んで参考ブロックを足す', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
    fs.mkdirSync(path.join(dir, 'shards'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ shards: [{ key: '2026-11' }] }));
    fs.writeFileSync(path.join(dir, 'shards', '2026-11.jsonl'), `${docs.map((d) => JSON.stringify(d)).join('\n')}\n{broken\n`);
    const out = await groundBrief('コスモヘドロンの面の数を紹介', { kbUrl: dir, enabled: true });
    expect(out.facts.length).toBe(1);
    expect(out.brief).toContain('参考（ナレッジベース）');
    expect(out.brief).toContain('https://github.com/x/lab');
  });

  test('KB が無くても素のブリーフを返す', async () => {
    const out = await groundBrief('何か', { kbUrl: '/nonexistent/kb', enabled: true });
    expect(out).toEqual({ brief: '何か', facts: [] });
  });

  test('無効化できる', async () => {
    expect(await groundBrief('x', { enabled: false })).toEqual({ brief: 'x', facts: [] });
  });

  test('事実が無ければブロックは空', () => {
    expect(factsBlock([])).toBe('');
  });
});
