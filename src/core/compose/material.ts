import type { CreativeControls, Slice, SliceCategory, SourceAudio } from '../types';
import type { Rng } from '../rng';
import { slicePitch } from '../slicing/slices';

/**
 * Material casting: decides which slices suit which musical job. Every score is a
 * soft tendency combining user tags (category, role, favourite) with measured
 * features (duration, attack, sustain, noisiness, pitch).
 */
export interface Material {
  slice: Slice;
  source: SourceAudio;
  dur: number;
  pitch: number | null;
  attack: number;
  sustain: number;
  noisiness: number;
  intensity: number;
  scores: { hook: number; perc: number; pad: number; ending: number; breath: number; accent: number; oneshot: number };
  /** gain trim (dB) that brings this slice to a common level */
  trim: number;
}

const CAT_BONUS: Record<string, Partial<Record<keyof Material['scores'], number>>> = {
  word: { hook: 1.4, ending: 1.3 },
  syllable: { hook: 1.3, perc: 1.1 },
  'sustained-vowel': { pad: 1.7, ending: 1.5, hook: 1.1 },
  'short-vowel': { hook: 1.3, perc: 1.2 },
  consonant: { perc: 1.8, accent: 1.5, hook: 0.6 },
  breath: { breath: 2, pad: 1.2, hook: 0.3 },
  whisper: { breath: 1.6, pad: 1.3, hook: 0.5 },
  'ad-lib': { accent: 1.6, hook: 1.2 },
  hum: { pad: 1.8, hook: 0.9 },
  'sung-note': { hook: 1.3, pad: 1.4, ending: 1.4 },
  spoken: { hook: 1.2 },
  percussive: { perc: 2, accent: 1.6, hook: 0.7 },
  other: {},
};

function gauss(x: number, mu: number, sigma: number) {
  const d = (x - mu) / sigma;
  return Math.exp(-0.5 * d * d);
}

export function buildMaterial(slices: Slice[], sources: SourceAudio[], c: CreativeControls): Material[] {
  const srcMap = new Map(sources.map((s) => [s.id, s]));
  const out: Material[] = [];
  for (const slice of slices) {
    const source = srcMap.get(slice.sourceId);
    if (!source || source.missing) continue;
    const dur = (slice.end - slice.start) / source.sampleRate;
    if (dur <= 0.004) continue;
    const a = slice.analysis;
    const attack = a?.attack ?? 0.5;
    const sustain = a?.sustain ?? 0.5;
    const noisiness = a?.noisiness ?? 0.3;
    const intensity = a?.intensity ?? 0.6;
    const pitch = slicePitch(slice, source);
    // Recognisability shifts the ideal hook length from tiny fragments to whole words.
    const hookTarget = 0.07 + c.recognisability * 0.45 * (1 - c.fragmentation * 0.6);
    const levelBias =
      slice.level === 'phrase' ? 0.4 + c.recognisability * 0.8 :
      slice.level === 'word' ? 0.6 + c.recognisability * 0.6 :
      slice.level === 'syllable' ? 1.1 - c.recognisability * 0.2 + c.fragmentation * 0.2 :
      0.7 + c.fragmentation * 0.6;
    const cat = CAT_BONUS[(slice.category ?? 'other') as SliceCategory] ?? {};
    const fav = slice.favourite ? 1.6 : 1;
    const roleBonus = (r: string) => (slice.role === r ? 1.8 : 1);
    const scores = {
      hook:
        gauss(Math.log(dur), Math.log(hookTarget), 0.9) * (0.4 + intensity) * (pitch !== null ? 1.2 : 0.9) *
        (1 - noisiness * 0.6) * levelBias * (cat.hook ?? 1) * fav * roleBonus('lead'),
      perc: (0.2 + attack * 1.3) * gauss(Math.log(dur), Math.log(0.09), 0.7) * (cat.perc ?? 1) * fav * roleBonus('rhythm'),
      pad:
        (0.2 + sustain) * (dur >= 0.9 ? 1 : gauss(Math.log(dur), Math.log(0.9), 0.8)) * (slice.tags.includes('sustained') ? 1.6 : 1) * (1.2 - attack * 0.6) * (cat.pad ?? 1) * fav *
        roleBonus('atmosphere'),
      ending: (0.3 + sustain) * gauss(Math.log(dur), Math.log(0.45), 0.8) * (cat.ending ?? 1) * fav,
      breath: (0.1 + noisiness) * (1.2 - intensity * 0.5) * (cat.breath ?? 1) * roleBonus('transition'),
      accent: (0.3 + attack) * (0.4 + intensity) * (cat.accent ?? 1) * fav * roleBonus('accent'),
      // one-shot: a clean, clearly pitched vowel that can be played like a sampler instrument
      oneshot:
        (pitch !== null ? 1 : 0.08) * (0.3 + (a?.pitchConfidence ?? 0.5)) * gauss(Math.log(dur), Math.log(0.24), 0.75) * (1 - noisiness) *
        (0.5 + intensity) * (slice.tags.includes('vowel') ? 1.7 : 1) * (slice.level === 'phrase' ? 0.2 : slice.level === 'word' ? 0.7 : 1) * fav * roleBonus('lead'),
    };
    // auto-level: bring every slice to a similar peak so chops sit evenly
    const pk = a?.peak ?? 0;
    const trim = pk > 0.001 ? Math.max(-6, Math.min(10, 20 * Math.log10(0.6 / pk))) : 0;
    out.push({ slice, source, dur, pitch, attack, sustain, noisiness, intensity, scores, trim: Math.round(trim * 10) / 10 });
  }
  return out;
}

export type ScoreKey = keyof Material['scores'];

/** Pick the top-k by score with a little seeded spread so seeds differ musically. */
export function pickTop(rng: Rng, mats: Material[], key: ScoreKey, k: number, spread = 0.35, exclude: Set<string> = new Set()): Material[] {
  const pool = mats.filter((m) => !exclude.has(m.slice.id));
  const ranked = pool
    .map((m) => ({ m, s: m.scores[key] * (1 + rng.float(-spread, spread)) }))
    .sort((a, b) => b.s - a.s);
  return ranked.slice(0, k).map((r) => r.m);
}

export interface Cast {
  hook: Material[];
  support: Material[];
  perc: Material[];
  pad: Material[];
  ending: Material;
  breath: Material[];
  accent: Material[];
  all: Material[];
  /** the best one-shot vowel: the "instrument" for sampler-style leads */
  voice: Material;
}

export function castMaterial(rng: Rng, mats: Material[], c: CreativeControls): Cast {
  if (!mats.length) throw new Error('No usable slices. Create some slices first.');
  const hookCount = c.repetition > 0.75 ? 1 : c.repetition > 0.45 ? 2 : 3;
  const hook = pickTop(rng, mats, 'hook', hookCount, 0.25 + c.surprise * 0.5);
  const used = new Set(hook.map((h) => h.slice.id));
  const support = pickTop(rng, mats, 'hook', 3, 0.5 + c.surprise * 0.5, used);
  const perc = pickTop(rng, mats, 'perc', 3, 0.4);
  const pad = pickTop(rng, mats, 'pad', 3, 0.4);
  const endingPool = pickTop(rng, mats, 'ending', 2, 0.3);
  const breath = pickTop(rng, mats, 'breath', 2, 0.3);
  const accent = pickTop(rng, mats, 'accent', 2, 0.3);
  const voice = pickTop(rng, mats, 'oneshot', 1, 0.2 + c.surprise * 0.4)[0] ?? hook[0];
  return {
    voice,
    hook,
    support: support.length ? support : hook,
    perc: perc.length ? perc : hook,
    pad: pad.length ? pad : hook,
    ending: endingPool[0] ?? hook[0],
    breath: breath.length ? breath : pad,
    accent: accent.length ? accent : perc,
    all: mats,
  };
}

export function describeMaterial(m: Material): string {
  return `“${m.slice.name}”${m.slice.category ? ` (${m.slice.category})` : ''}`;
}
