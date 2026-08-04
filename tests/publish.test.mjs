import { describe, expect, test } from 'bun:test';

import { ghHeaders } from '../scripts/video/publish.mjs';

describe('ghHeaders', () => {
  test('GitHub API に必要な 3 ヘッダを揃える', () => {
    const h = ghHeaders('tok');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h.Accept).toBe('application/vnd.github+json');
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  test('追加ヘッダをマージできる', () => {
    const h = ghHeaders('tok', { 'Content-Type': 'application/json' });
    expect(h['Content-Type']).toBe('application/json');
    expect(h.Authorization).toBe('Bearer tok');
  });

  test('API バージョンは固定する（暗黙のアップグレードで壊れないように）', () => {
    // GitHub は API バージョンを省略すると最新に追随する。
    // Release / アセットアップロードの挙動が変わると、
    // ある日突然パイプラインの最終段だけが落ちる。
    const h = ghHeaders('tok', { Accept: 'application/octet-stream' });
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  test('追加ヘッダで Accept を上書きできる（アセットのダウンロード用）', () => {
    const h = ghHeaders('tok', { Accept: 'application/octet-stream' });
    expect(h.Accept).toBe('application/octet-stream');
  });

  test('トークンは Authorization にだけ入る', () => {
    const h = ghHeaders('super-secret-token', { 'Content-Type': 'application/json' });
    const leaked = Object.entries(h).filter(
      ([k, v]) => k !== 'Authorization' && String(v).includes('super-secret-token')
    );
    expect(leaked).toEqual([]);
  });

  test('呼び出しごとに新しいオブジェクトを返す（共有状態を持たない）', () => {
    const a = ghHeaders('a');
    const b = ghHeaders('b');
    expect(a).not.toBe(b);
    expect(a.Authorization).toBe('Bearer a');
    expect(b.Authorization).toBe('Bearer b');
  });
});
