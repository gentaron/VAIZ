import { describe, expect, test } from 'bun:test';

import { extensionFor, isRetryable } from '../scripts/video/images.mjs';

describe('extensionFor', () => {
  // 画像生成 API は Content-Type を当てにできない (flux は JPEG を返す)。
  // 拡張子を間違えると render.mjs の findImage が見つけられず、
  // そのシーンだけ画像なしで進む。
  const magic = (...bytes) => Buffer.from(bytes);

  test('JPEG のマジックバイト (FF D8)', () => {
    expect(extensionFor(magic(0xff, 0xd8, 0xff, 0xe0))).toBe('jpg');
  });

  test('PNG のマジックバイト (89 50)', () => {
    expect(extensionFor(magic(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
  });

  test('WebP は 8〜12 バイト目の "WEBP" で判定する', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.from('VP8 ', 'ascii'),
    ]);
    expect(extensionFor(webp)).toBe('webp');
  });

  test('判別できないものは jpg に倒す', () => {
    // 未知の形式でも拡張子を返さないと保存先が決まらない。
    expect(extensionFor(magic(0x00, 0x01, 0x02, 0x03))).toBe('jpg');
  });

  test('短いバッファでも例外を投げない', () => {
    expect(extensionFor(Buffer.alloc(0))).toBe('jpg');
    expect(extensionFor(magic(0xff))).toBe('jpg');
    expect(extensionFor(magic(0x89))).toBe('jpg');
  });

  test('RIFF だが WEBP でないものは jpg 扱い', () => {
    const riffWave = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(extensionFor(riffWave)).toBe('jpg');
  });
});

describe('isRetryable', () => {
  // 無料枠のレート制限に当たるのは日常なので、429 を再試行しないと
  // パイプラインが毎日途中で落ちる。逆に 400 を再試行すると、
  // 直らないリクエストで無料枠を溶かす。

  test('429 (レート制限) は再試行する', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  test('5xx (サーバー側) は再試行する', () => {
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 502 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  test('status を持たないネットワークエラーは再試行する', () => {
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
    expect(isRetryable({})).toBe(true);
  });

  test('4xx (429 以外) は再試行しない', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  test('2xx / 3xx は再試行しない', () => {
    expect(isRetryable({ status: 200 })).toBe(false);
    expect(isRetryable({ status: 302 })).toBe(false);
  });
});
