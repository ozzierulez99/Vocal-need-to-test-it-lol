import type { Role, Candidate, CreativeControls, GeneratorSettings, Motif, Sequence, SeqEvent, Track, RhythmFeel } from '../types';
import { generate, defaultLayers, type GenerateInput } from './engine';
import { computeMetrics, similarity } from './metrics';
import { scoreHook } from './critic';
import type { HookScore, Groove } from '../types';
import { clamp, ticksPerBar } from '../time';
import { Rng } from '../rng';
import { buildMaterial } from './material';

/**
 * Candidate generation: each candidate is composed with a different musical
 * bias (not merely another seed). Labels are then assigned from the measured
 * metrics, so "Most spacious" really is the one with the most silence.
 */
export interface Profile {
  key: string;
  label: string;
  tweak: Partial<CreativeControls>;
  feel?: (f: RhythmFeel) => RhythmFeel;
  complexity?: number;
  /** Profiles may change the layer set (only when the user left layers on automatic). */
  layers?: (defaults: Role[]) => Role[];
  score: (m: ReturnType<typeof computeMetrics>) => number;
  explain: (m: ReturnType<typeof computeMetrics>) => string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export const PROFILES: Profile[] = [
  {
    key: 'melodic', label: 'Most melodic', tweak: { melodicMovement: 0.35, recognisability: 0.1, space: -0.05 },
    score: (m) => m.pitchSpread + (1 - m.silence) * 0.1, explain: (m) => `widest pitch movement (${pct(m.pitchSpread)})`,
  },
  {
    key: 'rhythmic', label: 'Most rhythmic', tweak: { fragmentation: 0.15, space: -0.2 }, complexity: 0.25,
    layers: (d) => Array.from(new Set([...d, 'rhythm', 'accent'] as Role[])),
    feel: (f) => (f === 'sparse' || f === 'hypnotic' ? 'syncopated' : f),
    score: (m) => m.syncopation * 0.7 + m.density * 0.6, explain: (m) => `syncopation ${pct(m.syncopation)}, density ${pct(m.density)}`,
  },
  {
    key: 'hypnotic', label: 'Most hypnotic', tweak: { repetition: 0.4, surprise: -0.3, melodicMovement: -0.2 },
    feel: () => 'hypnotic',
    score: (m) => m.repetition - m.variety * 0.4, explain: (m) => `bar-to-bar repetition ${pct(m.repetition)}`,
  },
  {
    key: 'spacious', label: 'Most spacious', tweak: { space: 0.45, fragmentation: -0.1 },
    layers: (d) => d.filter((r) => r !== 'rhythm' && r !== 'accent' && r !== 'atmosphere'),
    score: (m) => m.silence, explain: (m) => `${pct(m.silence)} silence`,
  },
  {
    key: 'fragmented', label: 'Most fragmented', tweak: { fragmentation: 0.45, recognisability: -0.3 },
    score: (m) => m.fragmentation, explain: (m) => `fragmentation ${pct(m.fragmentation)}`,
  },
  {
    key: 'surprising', label: 'Most surprising', tweak: { surprise: 0.45, repetition: -0.25 },
    layers: (d) => Array.from(new Set([...d, 'transition'] as Role[])),
    feel: (f) => (f === 'hypnotic' ? 'broken' : f),
    score: (m) => m.surprise, explain: (m) => `surprise index ${pct(m.surprise)}`,
  },
];

export function tweakSettings(s: GeneratorSettings, p: Profile, seed: number): GeneratorSettings {
  const c = { ...s.controls };
  for (const [k, v] of Object.entries(p.tweak)) (c as any)[k] = clamp((c as any)[k] + (v as number), 0, 1);
  const layers = !s.layers.length && p.layers && s.mode !== 'conversation' ? p.layers(defaultLayers(s.mode, { ...s, controls: c })) : s.layers;
  return { ...s, seed, controls: c, layers, feel: p.feel ? p.feel(s.feel) : s.feel, complexity: clamp(s.complexity + (p.complexity ?? 0), 0, 1) };
}

let candCounter = 0;
function candId() {
  candCounter = (candCounter + 1) % 1e6;
  return `cand_${Date.now().toString(36)}_${candCounter}`;
}

export interface CandidateRequest extends GenerateInput {
  count?: number;
  bars: number;
  /** attempts per idea for the hook critic to choose from (default 4) */
  attempts?: number;
}

export function generateCandidates(req: CandidateRequest): Candidate[] {
  const count = clamp(req.count ?? 6, 1, PROFILES.length);
  const base = req.settings;
  type Raw = { profile: Profile; settings: GeneratorSettings; out: ReturnType<typeof generate>; metrics: ReturnType<typeof computeMetrics>; score: HookScore };
  const raw: Raw[] = [];
  const critic = (settings: GeneratorSettings, out: ReturnType<typeof generate>) =>
    scoreHook({ events: out.events, tracks: out.tracks, slices: req.slices, sources: req.sources, bpm: req.bpm, timeSig: req.timeSig, bars: req.bars, settings, beat: req.beat });
  // Over-generate: several attempts per bias, keep the one the hook critic rates best
  // among those that are different enough from the ideas already chosen.
  const attempts = req.attempts ?? 4;
  for (let i = 0; i < count; i++) {
    const profile = PROFILES[i];
    let best: Raw | null = null;
    let bestDistinct: Raw | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const seed = (base.seed + i * 7919 + attempt * 104729) >>> 0;
      const settings = tweakSettings(base, profile, seed);
      const out = generate({ ...req, settings });
      const metrics = computeMetrics(out.events, req.slices, req.sources, req.bpm, req.timeSig, req.bars);
      const cand: Raw = { profile, settings, out, metrics, score: critic(settings, out) };
      const maxSim = Math.max(0, ...raw.map((r) => similarity(r.out.events, out.events)));
      if (!best || cand.score.total > best.score.total) best = cand;
      if (maxSim < 0.7 && (!bestDistinct || cand.score.total > bestDistinct.score.total)) bestDistinct = cand;
    }
    raw.push((bestDistinct ?? best)!);
  }
  // Assign labels from what was actually measured (greedy best match).
  const norm = PROFILES.slice(0, count).map((p) => {
    const vals = raw.map((r) => p.score(r.metrics));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    return vals.map((v) => (hi > lo ? (v - lo) / (hi - lo) : 0.5));
  });
  // optimal one-to-one label assignment (count ≤ 6 → brute force over permutations)
  const assigned = new Map<number, number>();
  let bestPerm: number[] = raw.map((_, i) => i);
  let bestVal = -Infinity;
  const perm = (arr: number[], k: number) => {
    if (k === arr.length) {
      let v = 0;
      arr.forEach((p, c) => (v += norm[p][c] + (raw[c].profile === PROFILES[p] ? 0.1 : 0)));
      if (v > bestVal) {
        bestVal = v;
        bestPerm = arr.slice();
      }
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm(raw.map((_, i) => i), 0);
  bestPerm.forEach((p, c) => assigned.set(c, p));
  return raw.map((r, i) => {
    const p = PROFILES[assigned.get(i) ?? i];
    return {
      id: candId(),
      label: p.label,
      profile: r.profile.key,
      settings: r.settings,
      tracks: r.out.tracks,
      events: r.out.events,
      motifs: r.out.motifs,
      metrics: r.metrics,
      description: [`${p.label}: ${p.explain(r.metrics)}`, ...r.out.description],
      favourite: false,
      createdAt: Date.now(),
      groove: r.out.groove,
      score: r.score,
    };
  });
}

/** Variations of a favourite: keep its identity, develop it in different directions. */
export function generateVariations(
  req: CandidateRequest,
  base: { tracks: Track[]; events: SeqEvent[]; motifs: Motif[]; settings: GeneratorSettings; groove?: Groove },
  count = 4,
  nonce = 0,
): Candidate[] {
  const out: Candidate[] = [];
  const existing = { tracks: base.tracks, events: base.events, motifs: base.motifs.map((m) => (m.id === 'motif-main' || m.important ? { ...m, important: true, protection: m.protection === 'replace' ? 'develop' : m.protection } : m)) as Motif[], lockedBars: req.existing?.lockedBars ?? [], lockedRests: req.existing?.lockedRests ?? [] };
  const bar = ticksPerBar(req.timeSig);
  const variants: { label: string; make: (seed: number) => ReturnType<typeof generate> }[] = [
    {
      label: 'Close variation',
      make: (seed) => generate({ ...req, settings: { ...base.settings, seed, controls: { ...base.settings.controls, surprise: clamp(base.settings.controls.surprise - 0.15, 0, 1) } }, existing: { ...existing, motifs: existing.motifs.map((m) => ({ ...m, protection: 'preserve' as const })) } }),
    },
    {
      label: 'Developed further',
      make: (seed) => generate({ ...req, settings: { ...base.settings, seed, controls: { ...base.settings.controls, surprise: clamp(base.settings.controls.surprise + 0.2, 0, 1) } }, existing: { ...existing, motifs: existing.motifs.map((m) => ({ ...m, protection: 'develop' as const })) } }),
    },
    {
      label: 'Same rhythm, new slices',
      make: (seed) => ({ tracks: base.tracks, motifs: base.motifs, events: reassignSlices(req, base.events, base.events.map((e) => e.id), seed), description: ['Kept every onset, re-chose slices with the same musical role'], groove: base.groove ?? { swing: 0, humanize: 0 } }),
    },
    {
      label: 'New ending',
      make: (seed) => {
        const phrase = Math.max(1, base.settings.phraseBars);
        const startBar = Math.max(0, req.bars - phrase);
        return generate({ ...req, settings: { ...base.settings, seed }, existing, scope: { startBar, endBar: req.bars } });
      },
    },
    {
      label: 'Denser',
      make: (seed) => generate({ ...req, settings: { ...base.settings, seed, controls: { ...base.settings.controls, space: clamp(base.settings.controls.space - 0.3, 0, 1), fragmentation: clamp(base.settings.controls.fragmentation + 0.15, 0, 1) } }, existing }),
    },
  ];
  void bar;
  for (let i = 0; i < Math.min(count, variants.length); i++) {
    const seed = (base.settings.seed + 31337 * (i + 1) + nonce * 7) >>> 0;
    const r = variants[i].make(seed);
    out.push({
      id: candId(),
      label: variants[i].label,
      profile: 'variation',
      settings: { ...base.settings, seed },
      tracks: r.tracks,
      events: r.events,
      motifs: r.motifs,
      metrics: computeMetrics(r.events, req.slices, req.sources, req.bpm, req.timeSig, req.bars),
      description: [variants[i].label, ...r.description],
      favourite: false,
      createdAt: Date.now(),
      groove: r.groove,
      score: scoreHook({ events: r.events, tracks: r.tracks, slices: req.slices, sources: req.sources, bpm: req.bpm, timeSig: req.timeSig, bars: req.bars, settings: base.settings, beat: req.beat }),
    });
  }
  return out;
}

/** Keep timing, choose different slices with a similar job (percussive ↔ percussive etc). */
export function reassignSlices(req: Pick<GenerateInput, 'slices' | 'sources' | 'settings'>, events: SeqEvent[], ids: string[], seed: number): SeqEvent[] {
  const mats = buildMaterial(req.slices, req.sources, req.settings.controls);
  if (mats.length < 2) return events;
  const rng = new Rng(`${seed}|reassign`);
  const sel = new Set(ids);
  const mapping = new Map<string, string>();
  const byId = new Map(mats.map((m) => [m.slice.id, m]));
  return events.map((e) => {
    if (!sel.has(e.id) || e.locked) return e;
    if (!mapping.has(e.sliceId)) {
      const cur = byId.get(e.sliceId);
      const key = cur && cur.attack > 0.7 ? 'perc' : cur && cur.sustain > 0.6 ? 'pad' : 'hook';
      const ranked = mats
        .filter((m) => m.slice.id !== e.sliceId && !Array.from(mapping.values()).includes(m.slice.id))
        .map((m) => ({ m, s: m.scores[key] * rng.float(0.6, 1.4) }))
        .sort((a, b) => b.s - a.s);
      mapping.set(e.sliceId, (ranked[0]?.m ?? cur ?? mats[0]).slice.id);
    }
    return { ...e, sliceId: mapping.get(e.sliceId)!, offset: 0 };
  });
}

export type { Sequence };
