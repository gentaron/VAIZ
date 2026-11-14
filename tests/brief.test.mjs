import { describe, expect, test } from 'bun:test';
import { formatCreativeBrief, parseCreativeBrief } from '../scripts/video/brief.mjs';

const sample = {
  schemaVersion: 1,
  type: 'creative-brief',
  status: 'draft',
  source: { url: 'https://example.org/story' },
  brief: {
    title: '新技術',
    context: '研究が発表された',
    goal: '仕組みを説明する',
    audience: '一般視聴者',
    keyPoints: ['何が変わるか'],
    references: ['https://example.org/story'],
  },
};

describe('creative brief input', () => {
  test('accepts a reviewed InfoCollect brief and keeps one source URL', () => {
    const out = parseCreativeBrief(sample);
    expect(out.references).toEqual(['https://example.org/story']);
    expect(formatCreativeBrief(out)).toContain('対象視聴者: 一般視聴者');
  });

  test('requires human editorial choices before calling a model', () => {
    expect(() => parseCreativeBrief({ ...sample, brief: { ...sample.brief, goal: '' } })).toThrow(/goal/);
  });

  test('rejects unsupported schemas and unsafe URLs', () => {
    expect(() => parseCreativeBrief({ ...sample, schemaVersion: 2 })).toThrow(/schemaVersion 1/);
    expect(() => parseCreativeBrief({ ...sample, source: { url: 'http://example.org/story' } })).toThrow(/HTTPS/);
  });
});

