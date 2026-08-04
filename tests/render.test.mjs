import { describe, expect, test } from 'bun:test';

import {
  assTime,
  buildASS,
  buildTimeline,
  charWidth,
  escapeAssText,
  kenBurnsExpr,
  wrapJapanese,
} from '../scripts/video/render.mjs';

// render.mjs は ffmpeg のコマンド引数と ASS 字幕を文字列で組み立てる。
// ここが壊れても ffmpeg はたいてい成功するので、エラーではなく
// 「見た目が微妙に違う動画」として出てくる。だから文字列の形を固定する。

describe('buildTimeline', () => {
  // PADDING=0.3 (前後の無音), XFADE_DUR=0.4 (シーン間の重なり)
  const timing = [
    { index: 0, duration: 5 },
    { index: 1, duration: 4 },
    { index: 2, duration: 6 },
  ];

  test('クリップ長 = 実測音声長 + 前後 0.3s の無音', () => {
    const { scenes } = buildTimeline(timing);
    expect(scenes[0].clipDur).toBeCloseTo(5.6, 6);
    expect(scenes[1].clipDur).toBeCloseTo(4.6, 6);
    expect(scenes[2].clipDur).toBeCloseTo(6.6, 6);
  });

  test('次のクリップは xfade のぶんだけ前に食い込む', () => {
    const { scenes } = buildTimeline(timing);
    expect(scenes[0].clipStart).toBeCloseTo(0, 6);
    expect(scenes[1].clipStart).toBeCloseTo(5.2, 6); // 5.6 - 0.4
    expect(scenes[2].clipStart).toBeCloseTo(9.4, 6); // 5.2 + 4.6 - 0.4
  });

  test('音声はクリップ内で 0.3s 遅れて始まり、実測長ぶん鳴る', () => {
    const { scenes } = buildTimeline(timing);
    for (const [i, s] of scenes.entries()) {
      expect(s.audioStart).toBeCloseTo(s.clipStart + 0.3, 6);
      expect(s.audioEnd - s.audioStart).toBeCloseTo(timing[i].duration, 6);
      // 音声がクリップの外にはみ出さないこと
      expect(s.audioEnd).toBeLessThanOrEqual(s.clipStart + s.clipDur + 1e-9);
    }
  });

  test('総尺は最後のクリップの終端', () => {
    const { total } = buildTimeline(timing);
    expect(total).toBeCloseTo(9.4 + 6.6, 6);
  });

  test('シーンが 1 本でも総尺が出る', () => {
    const { scenes, total } = buildTimeline([{ index: 0, duration: 7 }]);
    expect(scenes).toHaveLength(1);
    expect(total).toBeCloseTo(7.6, 6);
  });

  test('index は timing の値をそのまま引き継ぐ', () => {
    const { scenes } = buildTimeline(timing);
    expect(scenes.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  test('音声の再生位置は単調増加する（順序が入れ替わらない）', () => {
    const { scenes } = buildTimeline(timing);
    for (let i = 1; i < scenes.length; i++) {
      expect(scenes[i].audioStart).toBeGreaterThan(scenes[i - 1].audioStart);
    }
  });
});

describe('assTime', () => {
  test('ASS の h:mm:ss.cc 形式', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(5.5)).toBe('0:00:05.50');
    expect(assTime(65.43)).toBe('0:01:05.43');
    expect(assTime(3661.5)).toBe('1:01:01.50');
  });

  test('分と秒はゼロ埋めされる（libass が読めない形にならない）', () => {
    expect(assTime(9)).toBe('0:00:09.00');
    expect(assTime(69)).toBe('0:01:09.00');
  });

  test('センチ秒は切り捨て', () => {
    expect(assTime(1.999)).toBe('0:00:01.99');
  });
});

describe('escapeAssText', () => {
  test('制御文字になる \\ と {} を無害化する', () => {
    // これを外すと、ナレーションに { が入った瞬間に
    // 以降の字幕が override ブロックとして食われて消える。
    expect(escapeAssText('a\\b')).toBe('a＼b');
    expect(escapeAssText('{fade}')).toBe('(fade)');
  });

  test('連続する空白を 1 つに畳んで前後を落とす', () => {
    expect(escapeAssText('  a   b\n\nc  ')).toBe('a b c');
  });

  test('日本語はそのまま通す', () => {
    expect(escapeAssText('量子幾何学で市場を見る')).toBe('量子幾何学で市場を見る');
  });

  test('エスケープ後に制御文字が残らない', () => {
    const out = escapeAssText('{\\pos(0,0)}危険な\\N入力{');
    expect(out).not.toContain('\\');
    expect(out).not.toContain('{');
    expect(out).not.toContain('}');
  });
});

describe('charWidth', () => {
  test('半角は 0.5、全角は 1', () => {
    expect(charWidth('a')).toBe(0.5);
    expect(charWidth('1')).toBe(0.5);
    expect(charWidth(' ')).toBe(0.5);
    expect(charWidth('あ')).toBe(1);
    expect(charWidth('漢')).toBe(1);
    expect(charWidth('。')).toBe(1);
  });

  test('半角カタカナは 0.5', () => {
    expect(charWidth('ｱ')).toBe(0.5);
  });
});

describe('wrapJapanese', () => {
  const width = (line) => [...line].reduce((s, c) => s + charWidth(c), 0);

  test('短い行は折らない', () => {
    expect(wrapJapanese('短い文です', 17)).toEqual(['短い文です']);
  });

  test('空文字は空配列', () => {
    expect(wrapJapanese('', 17)).toEqual([]);
  });

  test('折り返しても文字は 1 つも失われない', () => {
    const text = 'AIエージェントが効く分野は、機械が採点できるループの強さで決まります。';
    expect(wrapJapanese(text, 17).join('')).toBe(text);
  });

  test('禁則に触れない限り maxWidth を超えない', () => {
    const text = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ';
    for (const line of wrapJapanese(text, 17)) {
      expect(width(line)).toBeLessThanOrEqual(17);
    }
  });

  test('句読点や閉じ括弧を行頭に置かない（ぶら下げる）', () => {
    const text = 'これは十七文字ちょうどの行です、続きの文章がここにあります。';
    for (const line of wrapJapanese(text, 17)) {
      expect('、。，．・：；？！ー〜）」』】'.includes(line[0])).toBe(false);
    }
  });

  test('開き括弧を行末に置かない（次の行へ送る）', () => {
    const text = 'あいうえおかきくけこさしすせそた「引用される内容がここに入ります」です';
    for (const line of wrapJapanese(text, 17)) {
      expect('（「『【〈《〔｛'.includes(line[line.length - 1])).toBe(false);
    }
  });

  test('半角英数は全角の半分しか幅を食わない', () => {
    const ascii = wrapJapanese('a'.repeat(34), 17);
    expect(ascii).toHaveLength(1); // 34 * 0.5 = 17
  });
});

describe('kenBurnsExpr', () => {
  test('偶数シーンはズームイン、奇数シーンはズームアウト', () => {
    expect(kenBurnsExpr(0, 30)).toBe('1+0.1800*on/29');
    expect(kenBurnsExpr(1, 30)).toBe('1.18-0.1800*on/29');
    expect(kenBurnsExpr(2, 30)).toBe('1+0.1800*on/29');
  });

  test('フレーム数が 1 以下でもゼロ除算にならない', () => {
    // span = max(frames-1, 1)。ここが 0 になると ffmpeg のフィルタが
    // NaN を吐いて、映像が真っ黒のまま成功扱いで通る。
    expect(kenBurnsExpr(0, 1)).toBe('1+0.1800*on/1');
    expect(kenBurnsExpr(0, 0)).toBe('1+0.1800*on/1');
  });

  test('ズーム倍率が最初のフレームで 1.0、最後で 1.18 になる', () => {
    // ffmpeg の zoompan は on (出力フレーム番号) の式として評価する。
    // 式を Function で実際に評価して、両端の倍率を確認する。
    const frames = 61;
    const span = frames - 1;
    const zoomAt = (i, on) =>
      // biome-ignore lint: テスト内でのみ、ffmpeg と同じ式を評価する
      new Function('on', `return ${kenBurnsExpr(i, frames)}`)(on);

    expect(zoomAt(0, 0)).toBeCloseTo(1, 6); // ズームイン開始
    expect(zoomAt(0, span)).toBeCloseTo(1.18, 6); // ズームイン終了
    expect(zoomAt(1, 0)).toBeCloseTo(1.18, 6); // ズームアウト開始
    expect(zoomAt(1, span)).toBeCloseTo(1, 6); // ズームアウト終了
  });
});

describe('buildASS', () => {
  const plan = {
    scenes: [
      { narration: '一つ目のナレーションです。', image_prompt: 'x', seconds: 5 },
      { narration: '二つ目のナレーションです。', image_prompt: 'y', seconds: 4 },
    ],
  };
  const timeline = buildTimeline([
    { index: 0, duration: 5 },
    { index: 1, duration: 4 },
  ]);

  test('シーン数ぶんの Dialogue 行を出す', () => {
    const ass = buildASS(plan, timeline);
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(2);
  });

  test('縦型 1080x1920 の解像度を宣言する', () => {
    const ass = buildASS(plan, timeline);
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
  });

  test('Dialogue の時刻は timeline の音声区間と一致する', () => {
    const ass = buildASS(plan, timeline);
    const first = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
    expect(first).toContain(assTime(timeline.scenes[0].audioStart));
    expect(first).toContain(assTime(timeline.scenes[0].audioEnd));
  });

  test('長いナレーションは \\N で改行される', () => {
    const long = {
      scenes: [
        {
          narration: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも',
          image_prompt: 'x',
          seconds: 5,
        },
      ],
    };
    const ass = buildASS(long, buildTimeline([{ index: 0, duration: 5 }]));
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
    expect(dialogue).toContain('\\N');
  });

  test('ナレーションの制御文字は Dialogue 行に漏れない', () => {
    const risky = {
      scenes: [{ narration: '{\\pos(500,500)}偽装した字幕', image_prompt: 'x', seconds: 5 }],
    };
    const ass = buildASS(risky, buildTimeline([{ index: 0, duration: 5 }]));
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
    // \N (自前の改行) 以外の制御シーケンスが残っていないこと
    expect(dialogue.replace(/\\N/g, '')).not.toContain('\\');
    expect(dialogue).not.toContain('{');
  });
});
