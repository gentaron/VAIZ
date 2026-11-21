const MAX_SECONDS = 30;
const TARGET_SECONDS = 15;
const SENTENCE_END = /[。！？!?]["'”’」』）)\]]*$/u;

function normalizeCaptions(captions) {
  if (!Array.isArray(captions)) throw new Error('captions must be an array of [start, end, text]');
  return captions
    .map((cue, i) => {
      if (!Array.isArray(cue) || cue.length < 3) throw new Error(`caption ${i} must be [start, end, text]`);
      const [start, end, text] = cue;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error(`caption ${i} needs finite seconds with end > start`);
      }
      if (typeof text !== 'string' || !text.trim()) throw new Error(`caption ${i} needs text`);
      const trimmed = text.trim();
      return { start, end, text: trimmed, complete: SENTENCE_END.test(trimmed) };
    })
    .sort((a, b) => a.start - b.start);
}

export function pickClipCandidate(captions, { maxSeconds = MAX_SECONDS, targetSeconds = TARGET_SECONDS } = {}) {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new Error('maxSeconds must be positive');
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) throw new Error('targetSeconds must be positive');

  const cues = normalizeCaptions(captions);
  const target = Math.min(targetSeconds, maxSeconds);
  let best = null;

  for (let i = 0; i < cues.length; i++) {
    if (i > 0 && !cues[i - 1].complete) continue;
    for (let j = i; j < cues.length; j++) {
      const duration = cues[j].end - cues[i].start;
      if (duration > maxSeconds || !cues[j].complete) continue;

      let gap = 0;
      for (let k = i + 1; k <= j; k++) gap += Math.max(0, cues[k].start - cues[k - 1].end);
      const countBonus = Math.min(j - i + 1, 4) / 4;
      const lengthFit = 1 - Math.min(1, Math.abs(duration - target) / target);
      const gapFit = 1 / (1 + gap);
      const score = Math.round((0.4 * countBonus + 0.4 * lengthFit + 0.2 * gapFit) * 100) / 100;
      if (!best || score > best.score) {
        best = {
          start: cues[i].start,
          end: cues[j].end,
          caption: cues.slice(i, j + 1).map((cue) => cue.text).join(' '),
          score,
        };
      }
    }
  }
  return best;
}
