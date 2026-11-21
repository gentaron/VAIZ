import { describe, expect, test } from 'bun:test';
import { pickClipCandidate } from '../scripts/video/clip-candidate.mjs';

const captions = [
  [0, 3, '今日は新しい技術を紹介します。'],
  [3, 6, 'まず字幕の区間を読んで'],
  [6, 9, '短いクリップにまとめます！'],
];

describe('pickClipCandidate', () => {
  test('3つの発話から文が完結する区間を1件返す', () => {
    const clip = pickClipCandidate(captions);
    expect(clip).toEqual({
      start: 0,
      end: 9,
      caption: '今日は新しい技術を紹介します。 まず字幕の区間を読んで 短いクリップにまとめます！',
      score: expect.any(Number),
    });
    expect(clip.score).toBeGreaterThan(0);
    expect(clip.score).toBeLessThanOrEqual(1);
  });

  test('上限を超える区間は選ばず、上限内の完結した文に留める', () => {
    const clip = pickClipCandidate(captions, { maxSeconds: 5 });
    expect(clip).not.toBeNull();
    expect(clip.start).toBe(0);
    expect(clip.end).toBe(3);
    expect(clip.end - clip.start).toBeLessThanOrEqual(5);
  });

  test('文が完結しなければ候補なし', () => {
    expect(pickClipCandidate([[0, 2, 'まだ続き'], [2, 4, 'です']])).toBeNull();
    expect(pickClipCandidate([])).toBeNull();
  });

  test('入力を変更せず、壊れた字幕は弾く', () => {
    const before = captions.map((cue) => [...cue]);
    pickClipCandidate(captions);
    expect(captions).toEqual(before);
    expect(() => pickClipCandidate([[0, 2, 'ok'], [2, 1, 'bad']])).toThrow(/end > start/);
    expect(() => pickClipCandidate([[0, 2, 42]])).toThrow(/needs text/);
  });
});
