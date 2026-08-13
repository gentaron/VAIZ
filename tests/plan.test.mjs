import { describe, expect, test } from 'bun:test';

import {
  buildUserPrompt,
  extractJson,
  hasVideoDelivered,
  isModelDead,
  isVideoBrief,
  oldestFirst,
  pickRescueTarget,
  PlanSchema,
} from '../scripts/video/plan.mjs';
import { DELIVERED_MARKER } from '../scripts/video/publish.mjs';

// plan.mjs は「信用できない出力 (LLM) を、下流 4 段が前提にできる形に変える」段。
// ここを通ったものは images / tts / render / publish が無検査で使うので、
// PlanSchema と extractJson が契約そのものになる。

describe('extractJson', () => {
  test('素の JSON をそのまま読む', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('```json フェンスを剥がす', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('言語指定なしのフェンスも剥がす', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('前後に地の文があっても本体を取り出す', () => {
    // 無料モデルは「はい、こちらが JSON です」と前置きを付けてくることが多い。
    const content = 'Sure! Here is the plan:\n{"a":1}\nLet me know if you need changes.';
    expect(extractJson(content)).toEqual({ a: 1 });
  });

  test('入れ子のオブジェクトを最後の } まで取る', () => {
    const content = 'prefix {"a":{"b":[1,2]},"c":"}"} suffix';
    expect(extractJson(content)).toEqual({ a: { b: [1, 2] }, c: '}' });
  });

  test('JSON が無ければ投げる（黙って undefined を返さない）', () => {
    expect(() => extractJson('no json here')).toThrow(/No JSON object found/);
    expect(() => extractJson('')).toThrow(/No JSON object found/);
    expect(() => extractJson('} {')).toThrow(/No JSON object found/);
  });

  test('壊れた JSON は SyntaxError として投げる', () => {
    expect(() => extractJson('{"a":}')).toThrow();
  });
});

describe('PlanSchema', () => {
  const scene = (seconds) => ({
    narration: 'これはナレーションです',
    image_prompt: 'a cinematic wide shot of a city at dusk',
    seconds,
  });
  const validPlan = {
    title: 'テスト動画',
    hook: '掴みの一文',
    scenes: Array.from({ length: 6 }, () => scene(8)), // 合計 48s
    hashtags: ['#ai', '#tech', '#news'],
  };

  test('妥当なプランを通す', () => {
    expect(PlanSchema.safeParse(validPlan).success).toBe(true);
  });

  test('シーン数は 6〜8', () => {
    const withScenes = (n) => ({
      ...validPlan,
      scenes: Array.from({ length: n }, () => scene(48 / n)),
    });
    expect(PlanSchema.safeParse(withScenes(5)).success).toBe(false);
    expect(PlanSchema.safeParse(withScenes(6)).success).toBe(true);
    expect(PlanSchema.safeParse(withScenes(8)).success).toBe(true);
    expect(PlanSchema.safeParse(withScenes(9)).success).toBe(false);
  });

  test('総尺は 35〜80 秒（目標 45〜60 より緩いハード制約）', () => {
    // 実尺は tts.mjs の実測値で決まるので、ここは緩く取ってある。
    const withTotal = (total) => ({
      ...validPlan,
      scenes: Array.from({ length: 6 }, () => scene(total / 6)),
    });
    expect(PlanSchema.safeParse(withTotal(30)).success).toBe(false);
    expect(PlanSchema.safeParse(withTotal(36)).success).toBe(true);
    expect(PlanSchema.safeParse(withTotal(60)).success).toBe(true);
    expect(PlanSchema.safeParse(withTotal(78)).success).toBe(true);
    expect(PlanSchema.safeParse(withTotal(90)).success).toBe(false);
  });

  test('1 シーンは 3〜15 秒', () => {
    const withFirst = (s) => ({
      ...validPlan,
      scenes: [scene(s), ...Array.from({ length: 5 }, () => scene(8))],
    });
    expect(PlanSchema.safeParse(withFirst(2)).success).toBe(false);
    expect(PlanSchema.safeParse(withFirst(3)).success).toBe(true);
    expect(PlanSchema.safeParse(withFirst(15)).success).toBe(true);
    expect(PlanSchema.safeParse(withFirst(16)).success).toBe(false);
  });

  test('ハッシュタグは 3〜10 個で、空文字を含まない', () => {
    expect(PlanSchema.safeParse({ ...validPlan, hashtags: ['#a', '#b'] }).success).toBe(false);
    expect(
      PlanSchema.safeParse({ ...validPlan, hashtags: Array(11).fill('#a') }).success
    ).toBe(false);
    expect(PlanSchema.safeParse({ ...validPlan, hashtags: ['#a', '#b', ''] }).success).toBe(
      false
    );
  });

  test('title は 100 文字以内で空にできない', () => {
    expect(PlanSchema.safeParse({ ...validPlan, title: '' }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...validPlan, title: 'あ'.repeat(101) }).success).toBe(false);
  });

  test('短すぎる narration / image_prompt を弾く', () => {
    // 空のナレーションが通ると、tts が無音の音声を作って
    // 「成功したが何も喋らない動画」が公開される。
    const bad = (over) => ({
      ...validPlan,
      scenes: [{ ...scene(8), ...over }, ...Array.from({ length: 5 }, () => scene(8))],
    });
    expect(PlanSchema.safeParse(bad({ narration: 'あ' })).success).toBe(false);
    expect(PlanSchema.safeParse(bad({ image_prompt: 'short' })).success).toBe(false);
  });

  test('必須フィールドが欠けたら通さない', () => {
    for (const key of ['title', 'hook', 'scenes', 'hashtags']) {
      const partial = { ...validPlan };
      delete partial[key];
      expect(PlanSchema.safeParse(partial).success).toBe(false);
    }
  });
});

describe('isModelDead', () => {
  test('モデルが使えないことを示すステータスを死判定にする', () => {
    // 400/401/402/403/404 = 廃止・権限なし・不正なスラッグ、429 = 枠切れ。
    // 無料モデルの slug は予告なく消えるので、この判定が次のモデルへの
    // 切り替えを駆動する。
    for (const code of [400, 401, 402, 403, 404, 429]) {
      expect(isModelDead(`OpenRouter ${code}: model not found`)).toBe(true);
    }
  });

  test('一時的なサーバー側の失敗は死判定にしない（同一モデルで再試行）', () => {
    for (const code of [500, 502, 503]) {
      expect(isModelDead(`OpenRouter ${code}: upstream error`)).toBe(false);
    }
  });

  test('OpenRouter 由来でないエラーは死判定にしない', () => {
    expect(isModelDead('fetch failed')).toBe(false);
    expect(isModelDead('Linear API 404: not found')).toBe(false);
    expect(isModelDead('')).toBe(false);
  });
});

describe('buildUserPrompt', () => {
  test('ブリーフ本文を含み、JSON 構造を指示する', () => {
    const p = buildUserPrompt('量子幾何学と市場の話', null);
    expect(p).toContain('量子幾何学と市場の話');
    expect(p).toContain('"scenes"');
    expect(p).toContain('no other text');
  });

  test('フィードバックがなければ再試行文を足さない', () => {
    expect(buildUserPrompt('brief', null)).not.toContain('previous attempt was rejected');
  });

  test('フィードバックがあれば却下理由を添えて再指示する', () => {
    const p = buildUserPrompt('brief', 'scenes must be 6-8');
    expect(p).toContain('previous attempt was rejected');
    expect(p).toContain('scenes must be 6-8');
  });
});

// ── 救済 claim ────────────────────────────────────────────────
// Todo は VAIZ 専用の待ち行列ではない。上流 (Genesis Vault の linear-write) が
// ラベル無関係に最古の Todo を持っていくので、ブリーフは In Progress /
// In Review に取り残されうる。完了条件を「Todo に居ないこと」ではなく
// 「動画が届いていること」に置いているのがここ。

describe('isVideoBrief', () => {
  test('VE-009 が起こしたブリーフを見分ける', () => {
    expect(isVideoBrief('本文\n<!-- gv:source=2026-08-12-post-7hrf6p -->')).toBe(true);
    expect(isVideoBrief('VAIZ の video-loop がこの本文をそのまま企画素材として読む。')).toBe(true);
  });

  test('人間が書いた普通の企画は動画ブリーフ扱いしない', () => {
    // ここを緩めると、記事用の企画から勝手に動画を作り始める。
    expect(isVideoBrief('新しい記事の企画。まだ動画にはしない。')).toBe(false);
    expect(isVideoBrief('')).toBe(false);
    expect(isVideoBrief(null)).toBe(false);
    expect(isVideoBrief(undefined)).toBe(false);
  });
});

describe('hasVideoDelivered', () => {
  const withComments = (...bodies) => ({ comments: { nodes: bodies.map((body) => ({ body })) } });

  test('publish.mjs の印があれば届いている', () => {
    // publish.mjs 側の定数をそのまま import している。片方だけ書き換えると
    // ここが落ちる（= 同じ Issue を毎晩作り直す事故を検知する）。
    expect(hasVideoDelivered(withComments(`${DELIVERED_MARKER}\n動画を生成しました。`))).toBe(true);
  });

  test('印を入れる前に届けた旧いコメントも完了として扱う', () => {
    expect(hasVideoDelivered(withComments('動画を生成しました。内容を確認してから…'))).toBe(true);
  });

  test('失敗通知や上流のコメントは完了にしない', () => {
    expect(hasVideoDelivered(withComments('動画生成ワークフローが失敗しました。'))).toBe(false);
    expect(hasVideoDelivered(withComments('Draft is ready for review.\n\nhttps://…/pull/233'))).toBe(
      false,
    );
    expect(hasVideoDelivered(withComments())).toBe(false);
    expect(hasVideoDelivered({})).toBe(false);
  });
});

describe('oldestFirst', () => {
  test('作成が古い順に並べ、元の配列を壊さない', () => {
    // Linear の orderBy は降順固定なので、古い順はこちらで作る。
    const nodes = [{ createdAt: '2026-08-12T00:00:00Z' }, { createdAt: '2026-08-04T00:00:00Z' }];
    expect(oldestFirst(nodes).map((n) => n.createdAt)).toEqual([
      '2026-08-04T00:00:00Z',
      '2026-08-12T00:00:00Z',
    ]);
    expect(nodes[0].createdAt).toBe('2026-08-12T00:00:00Z');
  });
});

describe('pickRescueTarget', () => {
  const brief = (id, createdAt, comments = []) => ({
    id,
    identifier: id,
    createdAt,
    description: `ブリーフ本文\n<!-- gv:source=${id} -->`,
    comments: { nodes: comments.map((body) => ({ body })) },
  });

  test('動画がまだ無いブリーフのうち最も古いものを選ぶ', () => {
    const target = pickRescueTarget([
      brief('GEN-17', '2026-08-12T12:06:00Z'),
      brief('GEN-9', '2026-08-04T13:14:00Z'),
    ]);
    expect(target.id).toBe('GEN-9');
  });

  test('既に動画が付いたブリーフは飛ばす', () => {
    const target = pickRescueTarget([
      brief('GEN-8', '2026-08-03T11:03:00Z', [`${DELIVERED_MARKER}\n動画を生成しました。`]),
      brief('GEN-9', '2026-08-04T13:14:00Z'),
    ]);
    expect(target.id).toBe('GEN-9');
  });

  test('ブリーフでない Issue は救済しない', () => {
    const article = {
      id: 'GEN-20',
      createdAt: '2026-01-01T00:00:00Z',
      description: '記事の企画',
      comments: { nodes: [] },
    };
    expect(pickRescueTarget([article])).toBeNull();
  });

  test('候補が無ければ null（呼び出し側が「何もしない」を選べるように）', () => {
    expect(pickRescueTarget([])).toBeNull();
  });
});
