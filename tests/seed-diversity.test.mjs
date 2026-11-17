import { describe, expect, test } from 'bun:test';
import {
  directionalConcentration,
  evaluateSeedDiversity,
  frameFeature,
  meanPairwiseSimilarity,
  seedCentroid,
} from '../scripts/video/seed-diversity.mjs';

const SIZE = 8;

function frame(r, g, b) {
  const pixels = new Uint8Array(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    pixels[i * 3] = r;
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = b;
  }
  return frameFeature(pixels, SIZE, SIZE, 4);
}

function seed(colors) {
  return seedCentroid(colors.map(([r, g, b]) => frame(r, g, b)));
}

describe('frameFeature', () => {
  test('builds a normalized downscaled RGB histogram', () => {
    const feature = frame(255, 0, 0);
    expect(feature).toHaveLength(64);
    expect(feature.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    expect(feature[3 * 16]).toBeCloseTo(1, 10);
  });
  test('rejects short pixel buffers and invalid dimensions', () => {
    expect(() => frameFeature(new Uint8Array(2), 1, 1)).toThrow();
    expect(() => frameFeature(new Uint8Array(3), 0, 1)).toThrow();
  });
});

describe('seed diversity probe', () => {
  test('passes a diverse synthetic seed set', () => {
    const result = evaluateSeedDiversity([
      seed([[255, 0, 0], [250, 0, 0]]),
      seed([[0, 255, 0], [0, 250, 0]]),
      seed([[0, 0, 255], [0, 0, 250]]),
      seed([[255, 255, 255], [250, 250, 250]]),
    ]);
    expect(result.verdict).toBe('pass');
    expect(result.meanSimilarity).toBeLessThan(0.5);
    expect(result.concentration).toBeLessThan(0.85);
  });
  test('warns when different seeds collapse to the same sample', () => {
    const result = evaluateSeedDiversity([
      seed([[128, 128, 128], [130, 128, 128]]),
      seed([[128, 128, 128], [128, 130, 128]]),
      seed([[128, 128, 128], [128, 128, 130]]),
      seed([[128, 128, 128], [130, 130, 128]]),
    ]);
    expect(result.verdict).toBe('warn');
    expect(result.meanSimilarity).toBeGreaterThan(0.99);
    expect(result.concentration).toBeGreaterThan(0.99);
  });
  test('concentration grows when covariance points one way', () => {
    const spread = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]];
    const concentrated = [[1, 0, 0], [1, 0.01, 0], [1, 0, 0.01], [1, 0, 0]];
    expect(meanPairwiseSimilarity(spread)).toBeLessThan(meanPairwiseSimilarity(concentrated));
    expect(directionalConcentration(concentrated)).toBeGreaterThan(
      directionalConcentration(spread),
    );
  });
});
