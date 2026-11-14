/** Generate out/plan.json from a reviewed creative-brief file, without Linear. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCreativeBrief, formatCreativeBrief } from './brief.mjs';
import { generatePlan } from './plan.mjs';
import { groundBrief } from './ground.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main() {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    throw new Error('Usage: bun run video:plan:brief path/to/brief.json');
  }
  const brief = parseCreativeBrief(JSON.parse(await fs.readFile(path.resolve(file), 'utf8')));
  const outDir = path.join(root, 'out');
  let existing = [];
  try { existing = await fs.readdir(outDir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing.length) throw new Error('out/ already has files; move or clear the previous draft before starting another');
  const grounded = await groundBrief(formatCreativeBrief(brief));
  const plan = await generatePlan(grounded.brief);
  const output = {
    ...plan,
    _sources: [...new Set([...brief.references, ...grounded.facts.map((fact) => fact.url)])],
    _input: 'creative-brief',
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'plan.json'), `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`Draft video plan saved to ${path.join(outDir, 'plan.json')}`);
  console.log('Run video:images, video:tts, video:render for a local draft. Do not run video:publish.');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

