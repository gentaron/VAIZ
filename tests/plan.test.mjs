import { describe, expect, test } from 'bun:test';

import {
  buildUserPrompt,
  extractJson,
  isModelDead,
  PlanSchema,
} from '../scripts/video/plan.mjs';

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
