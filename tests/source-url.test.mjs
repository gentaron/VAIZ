import { describe, expect, test } from 'bun:test';
import { isPublicHttpsSource } from '../scripts/video/source-url.mjs';

describe('evidence source admission', () => {
  test('accepts normal public HTTPS evidence', () => {
    expect(isPublicHttpsSource('https://example.org/research?id=8')).toBe(true);
    expect(isPublicHttpsSource('https://github.com/gentaron/Mathematical-Physics-Lab-')).toBe(true);
  });
  test('rejects credentialed, non-HTTPS, and private/internal URLs', () => {
    for (const url of [
      'http://example.org/x', 'https://user:secret@example.org/x',
      'https://localhost/x', 'https://127.0.0.1/x',
      'https://192.168.1.2/x', 'https://[::1]/x',
      'https://metadata.internal/latest', 'javascript:alert(1)',
    ]) expect(isPublicHttpsSource(url)).toBe(false);
  });
});
