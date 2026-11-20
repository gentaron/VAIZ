import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const EPS = 1e-12;
const FRAME_SIZE = 32;
const MAX_SAMPLES = 4096;

export function frameFeature(pixels, width, height, bins = 4) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('width and height must be positive integers');
  }
  if (!Number.isInteger(bins) || bins < 2) throw new Error('bins must be an integer >= 2');
  if (pixels.length < width * height * 3) throw new Error('pixel buffer is too short');

  const feature = new Float64Array(bins ** 3);
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / MAX_SAMPLES)));
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 3;
      const r = Math.min(bins - 1, Math.floor((pixels[i] * bins) / 256));
      const g = Math.min(bins - 1, Math.floor((pixels[i + 1] * bins) / 256));
      const b = Math.min(bins - 1, Math.floor((pixels[i + 2] * bins) / 256));
      feature[(r * bins + g) * bins + b] += 1;
      total += 1;
    }
  }
  if (total > 0) for (let i = 0; i < feature.length; i++) feature[i] /= total;
  return Array.from(feature);
}
export function seedCentroid(features) {
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error('seed needs at least one frame');
  }
  const dimensions = features[0].length;
  const centroid = new Array(dimensions).fill(0);
  for (const feature of features) {
    if (feature.length !== dimensions) throw new Error('feature dimensions differ');
    for (let i = 0; i < dimensions; i++) centroid[i] += feature[i];
  }
  for (let i = 0; i < dimensions; i++) centroid[i] /= features.length;
  return centroid;
}
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
function norm(a) {
  return Math.sqrt(dot(a, a));
}
function cosine(a, b) {
  const denominator = norm(a) * norm(b);
  return denominator > EPS ? dot(a, b) / denominator : 0;
}
export function meanPairwiseSimilarity(vectors) {
  if (!Array.isArray(vectors) || vectors.length < 2) throw new Error('need at least two seeds');
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosine(vectors[i], vectors[j]);
      pairs += 1;
    }
  }
  return sum / pairs;
}
export function directionalConcentration(vectors, iterations = 100) {
  if (!Array.isArray(vectors) || vectors.length < 2) throw new Error('need at least two seeds');
  const count = vectors.length;
  const dimensions = vectors[0].length;
  const mean = new Array(dimensions).fill(0);
  for (const vector of vectors) {
    if (vector.length !== dimensions) throw new Error('feature dimensions differ');
    for (let i = 0; i < dimensions; i++) mean[i] += vector[i] / count;
  }
  const centered = vectors.map((vector) => vector.map((value, i) => value - mean[i]));
  let trace = 0;
  for (const row of centered) for (const value of row) trace += (value * value) / count;
  if (trace <= EPS) return 1;

  let eigenvector = Array.from({ length: dimensions }, (_, i) => Math.sin(i + 1));
  const initialNorm = norm(eigenvector);
  eigenvector = eigenvector.map((value) => value / initialNorm);
  let eigenvalue = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = new Array(dimensions).fill(0);
    for (const row of centered) {
      const projection = dot(row, eigenvector) / count;
      for (let i = 0; i < dimensions; i++) next[i] += row[i] * projection;
    }
    const nextNorm = norm(next);
    if (nextNorm <= EPS) return 0;
    eigenvector = next.map((value) => value / nextNorm);
    eigenvalue = dot(eigenvector, next);
  }
  return Math.max(0, Math.min(1, eigenvalue / trace));
}
export function evaluateSeedDiversity(vectors, { maxMeanSimilarity = 0.98, maxConcentration = 0.85 } = {}) {
  const meanSimilarity = meanPairwiseSimilarity(vectors);
  const concentration = directionalConcentration(vectors);
  const warnings = [];
  if (meanSimilarity >= maxMeanSimilarity) {
    warnings.push(`mean seed similarity ${meanSimilarity.toFixed(3)} >= ${maxMeanSimilarity}`);
  }
  if (concentration >= maxConcentration) {
    warnings.push(`eigenvalue concentration ${concentration.toFixed(3)} >= ${maxConcentration}`);
  }
  return {
    seeds: vectors.length,
    dimensions: vectors[0].length,
    meanSimilarity,
    concentration,
    verdict: warnings.length > 0 ? 'warn' : 'pass',
    warnings,
  };
}
function decodeFrame(file) {
  const buffer = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-vf', `scale=${FRAME_SIZE}:${FRAME_SIZE}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: FRAME_SIZE * FRAME_SIZE * 3 * 4, timeout: 60_000 });
  if (buffer.length !== FRAME_SIZE * FRAME_SIZE * 3) {
    throw new Error(`Could not decode frame: ${file}`);
  }
  return { pixels: new Uint8Array(buffer), width: FRAME_SIZE, height: FRAME_SIZE };
}
function main() {
  const root = process.argv[2] || path.join(process.cwd(), 'out', 'diversity');
  const seeds = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (seeds.length < 2) throw new Error(`Need at least two seed subdirectories under ${root}`);

  const vectors = seeds.map((seed) => {
    const directory = path.join(root, seed);
    const files = readdirSync(directory)
      .filter((file) => /\.(jpe?g|png|webp)$/i.test(file))
      .sort();
    if (files.length === 0) throw new Error(`No frames in ${directory}`);
    return seedCentroid(files.map((file) => {
      const frame = decodeFrame(path.join(directory, file));
      return frameFeature(frame.pixels, frame.width, frame.height);
    }));
  });

  const result = evaluateSeedDiversity(vectors);
  console.log(JSON.stringify({ ...result, seedNames: seeds }, null, 2));
  if (result.verdict === 'warn') {
    console.warn('WARNING: seed diversity collapse suspected');
    process.exitCode = 1;
  }
}
if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
