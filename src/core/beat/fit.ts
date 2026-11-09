import type { BeatChord, BeatContext, GeneratorSettings, ScaleName, Slice, SourceAudio, Direction, RhythmFeel, ComposeMode, BeatFit, Role } from '../types';
import { PPQ } from '../types';
import { keyName, scalePcs, barTicks } from './analyze';
import { slicePitch } from '../slicing/slices';
import { midiToName, clamp } from '../time';
import type { Rng } from '../rng';

/** Key actually used for composition (user override wins over detection). */
export function effectiveKey(b: BeatContext): { root: number; scale: ScaleName } {
  return b.keyOverride ?? { root: b.key.root, scale: b.key.scale };
}

/** Chord sounding at an arrangement tick (the beat loop repeats). */
export function chordAt(b: BeatContext, tick: number): BeatChord | null {
  if (!b.chords.length || b.lengthTicks <= 0) return null;
  const t = ((tick % b.lengthTicks) + b.lengthTicks) % b.lengthTicks;
  return b.chords.find((c) => t >= c.tick && t < c.tick + c.length) ?? b.chords[b.chords.length - 1];
}

/** Chord-change positions across an arrangement of `totalTicks`. */
export function chordChanges(b: BeatContext, totalTicks: number): number[] {
  const out: number[] = [];
  for (let base = 0; base < totalTicks; base += b.lengthTicks) for (const c of b.chords) if (base + c.tick < totalTicks) out.push(base + c.tick);
  return out;
}

export interface Hit {
  step: number;
  len: number;
  accent: boolean;
}

/**
 * Rhythm fit for generated hits (steps are sixteenths from a bar line).
 * complement: move/drop weak hits that collide with the beat's busiest steps so the vocal sits in the gaps.
 * follow: pull hits onto steps where the beat plays, so the chops lock to its groove.
 */
export function fitHits(hits: Hit[], b: BeatContext, mode: BeatFit['rhythm'], rng: Rng): { hits: Hit[]; moved: number; dropped: number } {
  if (mode === 'off' || !hits.length) return { hits, moved: 0, dropped: 0 };
  const spb = b.rhythm.steps.length;
  const occ = (s: number) => b.rhythm.steps[((s % spb) + spb) % spb] ?? 0;
  const out: Hit[] = [];
  const taken = new Set<number>();
  let moved = 0;
  let dropped = 0;
  const maxStep = Math.max(...hits.map((h) => h.step)) + 1;
  hits.forEach((h, i) => {
    let s = h.step;
    if (mode === 'complement' && occ(s) >= 0.5 && i > 0) {
      const options = [s + 1, s - 1, s + 2, s - 2].filter((x) => x >= 0 && x < maxStep + 2 && !taken.has(x) && occ(x) < 0.35);
      if (options.length) {
        s = options[0];
        moved++;
      } else if (!h.accent && rng.chance(0.6)) {
        dropped++;
        return;
      }
    } else if (mode === 'follow' && occ(s) < 0.3) {
      const options = [s - 1, s + 1, s - 2, s + 2].filter((x) => x >= 0 && !taken.has(x) && occ(x) >= 0.5);
      if (options.length) {
        s = options[0];
        moved++;
      }
    }
    if (taken.has(s)) {
      dropped++;
      return;
    }
    taken.add(s);
    out.push({ ...h, step: s });
  });
  out.sort((a, b2) => a.step - b2.step);
  return { hits: out.length ? out : hits.slice(0, 1), moved, dropped };
}

/** Steps (of one bar) where the beat is busy / sparse. */
export function busyStep(b: BeatContext, absStep: number): number {
  const spb = b.rhythm.steps.length;
  return b.rhythm.steps[((absStep % spb) + spb) % spb] ?? 0;
}

export interface HarmonizeNote {
  tick: number;
  length: number;
  semitones: number;
  velocity: number;
  sliceId: string;
  gesture?: string;
  motifId?: string;
}

/**
 * Nudge pitched vocal notes toward the harmony: strong notes (on the beat, accented
 * or long) snap to a tone of the chord underneath, others – and every rhythm or
 * transition chop – to the key's scale.
 * Only small moves are made so melodic shapes survive; realised as playback-rate
 * transposition like every other pitch change.
 */
export function harmonize(
  notes: HarmonizeNote[],
  b: BeatContext,
  pitchOf: (sliceId: string) => number | null,
  opts: { beatTicks: number; role: Role; skip?: (n: HarmonizeNote) => boolean },
): number {
  const key = effectiveKey(b);
  const scale = new Set(scalePcs(key.root, key.scale));
  let changed = 0;
  const maxMove = opts.role === 'atmosphere' ? 5 : 3;
  for (const n of notes) {
    if (opts.skip?.(n)) continue;
    const natural = pitchOf(n.sliceId);
    if (natural === null) continue;
    const p = natural + n.semitones;
    const chord = chordAt(b, n.tick);
    // rhythm chops and transitions only need to stay in key; melodic layers also follow the chords
    const scaleOnly = opts.role === 'rhythm' || opts.role === 'transition';
    const strong = !scaleOnly && (n.tick % opts.beatTicks === 0 || n.velocity >= 0.85 || n.length >= opts.beatTicks || opts.role === 'atmosphere');
    const targets = strong && chord && chord.quality !== 'note' ? new Set(chord.pcs) : scale;
    let best: number | null = null;
    for (let d = 0; d <= maxMove; d++) {
      for (const q of [Math.round(p) + d, Math.round(p) - d]) {
        if (targets.has(((q % 12) + 12) % 12) && (best === null || Math.abs(q - p) < Math.abs(best - p))) best = q;
      }
      if (best !== null) break;
    }
    if (best === null) continue;
    const semis = clamp(Math.round((best - natural) * 100) / 100, -12, 12);
    if (Math.abs(semis - n.semitones) > 0.01) {
      n.semitones = semis;
      changed++;
    }
  }
  return changed;
}

export interface VocalFit {
  pitched: number;
  inKey: string[];
  near: string[];
  outOfKey: string[];
  unpitched: string[];
  /** semitone shift that would put most pitched vocal material into the beat's key (0 = already fits) */
  suggestedShift: number;
  fitRatio: number;
}

/** How well the vocal's slices (natural pitch) sit in the beat's key. */
export function vocalKeyFit(slices: Slice[], sources: SourceAudio[], b: BeatContext): VocalFit {
  const key = effectiveKey(b);
  const scale = new Set(scalePcs(key.root, key.scale));
  const src = new Map(sources.map((s) => [s.id, s]));
  const res: VocalFit = { pitched: 0, inKey: [], near: [], outOfKey: [], unpitched: [], suggestedShift: 0, fitRatio: 0 };
  const pitches: { p: number; w: number }[] = [];
  for (const s of slices) {
    const source = src.get(s.sourceId);
    if (!source || source.missing) continue;
    const p = slicePitch(s, source);
    if (p === null || (s.analysis && s.analysis.noisiness > 0.6)) {
      res.unpitched.push(s.id);
      continue;
    }
    res.pitched++;
    pitches.push({ p, w: (s.end - s.start) / source.sampleRate });
    const pcf = ((p % 12) + 12) % 12;
    const nearest = Math.round(pcf) % 12;
    const off = Math.abs(pcf - Math.round(pcf));
    if (scale.has(nearest) && off < 0.35) res.inKey.push(s.id);
    else if (scale.has((nearest + 1) % 12) || scale.has((nearest + 11) % 12)) res.near.push(s.id);
    else res.outOfKey.push(s.id);
  }
  res.fitRatio = res.pitched ? res.inKey.length / res.pitched : 1;
  // best global shift (−6..+5) by duration-weighted in-scale share
  let best = { shift: 0, score: -1 };
  for (let sh = -6; sh <= 5; sh++) {
    let sc = 0;
    for (const { p, w } of pitches) if (scale.has(((Math.round(p + sh) % 12) + 12) % 12)) sc += w;
    if (sc > best.score + 1e-9 || (Math.abs(sc - best.score) < 1e-9 && Math.abs(sh) < Math.abs(best.shift))) best = { shift: sh, score: sc };
  }
  let atZero = 0;
  for (const { p, w } of pitches) if (scale.has(((Math.round(p) % 12) + 12) % 12)) atZero += w;
  // only suggest moving the vocal when that clearly improves the fit
  res.suggestedShift = best.score > atZero * 1.2 + 1e-9 ? best.shift : 0;
  return res;
}

/** Plain-language description of the beat for the UI. */
export function describeBeat(b: BeatContext): string[] {
  const k = effectiveKey(b);
  const r = b.rhythm;
  const bars = b.lengthTicks / barTicks(b.timeSig);
  const out: string[] = [];
  out.push(`${keyName(k.root, k.scale)}${b.keyOverride ? ' (set by you)' : ` (detected, ${Math.round(b.key.confidence * 100)}% confidence)`}`);
  out.push(`${bars} bar loop · ${b.chords.map((c) => c.symbol).join(' – ') || 'no clear chords'} · chords change every ${r.harmonicRhythm === 1 ? 'bar' : `${r.harmonicRhythm} bars`}`);
  const kindText = { chords: 'block chords / pads', arp: 'an arpeggio', melody: 'a single-note line', mixed: 'chords with movement' }[r.kind];
  const busy = r.onsetsPerBeat >= 2 ? 'busy' : r.onsetsPerBeat >= 0.9 ? 'moderately active' : 'sparse';
  out.push(`Reads as ${kindText}: ${busy} (${r.onsetsPerBeat.toFixed(1)} onsets per beat), ${r.sustain > 0.7 ? 'sustained' : r.sustain > 0.4 ? 'medium-length' : 'short, plucky'} notes around ${midiToName(r.register)}`);
  const free = r.steps.map((v, i) => ({ v, i })).filter((x) => x.v < 0.2).length;
  out.push(`${free} of ${r.steps.length} sixteenth positions per bar are free of beat onsets${r.syncopation > 0.45 ? '; the beat is syncopated' : ''}`);
  if (b.bpm) out.push(`${Math.round(b.bpm)} BPM${b.bpm >= 130 && b.bpm <= 160 && r.onsetsPerBeat < 1 ? ' – could be felt half-time' : ''}`);
  return out;
}

export interface BeatRecipe {
  id: string;
  title: string;
  why: string;
  settings: Partial<GeneratorSettings>;
  fit: Partial<BeatFit>;
}

/**
 * Curated starting points for this beat. Each recipe is a set of generator
 * settings chosen from the beat's tempo, density, sustain and harmonic rhythm.
 */
export function beatRecipes(b: BeatContext, opts: { sources: number }): BeatRecipe[] {
  const r = b.rhythm;
  const bpm = b.bpm ?? 140;
  const key = effectiveKey(b);
  const loopBars = Math.max(1, Math.round(b.lengthTicks / barTicks(b.timeSig)));
  const phraseBars = clamp(r.harmonicRhythm >= 2 ? 4 : loopBars >= 4 ? 2 : Math.max(1, loopBars), 1, 4);
  const busy = r.onsetsPerBeat >= 2 || r.kind === 'arp';
  const sustained = r.sustain > 0.65 && r.kind !== 'arp';
  const slowFeel = bpm < 100 || (bpm >= 130 && r.onsetsPerBeat < 1);
  const fast = bpm >= 150 && !slowFeel;
  const base = { keyRoot: key.root, scale: key.scale, transpose: true, phraseBars, layers: [] as Role[] };
  const space = (x: number) => clamp(x + (busy ? 0.2 : -0.05), 0, 1);
  const hookDir: Direction = slowFeel ? 'ethereal' : fast ? 'playful' : 'emotional';
  const recipes: BeatRecipe[] = [
    {
      id: 'hook',
      title: 'Hook in key, on the chords',
      why: `A ${hookDir === 'ethereal' ? 'floating' : hookDir === 'playful' ? 'bright, bouncy' : 'repeating, emotional'} melodic hook in ${keyName(key.root, key.scale)}; strong notes land on chord tones, ${phraseBars}-bar phrases follow the ${r.harmonicRhythm >= 2 ? 'slow' : ''} chord changes${busy ? ', with extra space because the beat is busy' : ''}.`,
      settings: { ...base, mode: 'melodic', direction: hookDir, feel: hookDir === 'ethereal' ? 'hypnotic' : hookDir === 'playful' ? 'bouncy' : 'bouncy', controls: { recognisability: 0.6, repetition: 0.7, fragmentation: 0.3, space: space(0.5), melodicMovement: 0.45, surprise: 0.2 } },
      fit: { harmonize: true, rhythm: 'complement' },
    },
    {
      id: 'gaps',
      title: busy ? 'Chops in the gaps' : 'Rhythmic chops over the chords',
      why: busy
        ? `Your ${r.kind === 'arp' ? 'arp' : 'beat'} is busy, so syllable chops are placed on the sixteenths it leaves free – call and response with the beat itself.`
        : `The beat ${sustained ? 'sustains' : 'leaves room'}, so the vocal can carry the rhythm: syncopated chops, accents and stutters, kept in key.`,
      settings: { ...base, mode: 'rhythmic', direction: fast ? 'playful' : 'dance', feel: r.syncopation > 0.45 ? 'tight' : 'syncopated', controls: { recognisability: 0.45, repetition: 0.7, fragmentation: 0.55, space: space(busy ? 0.45 : 0.25), melodicMovement: 0.35, surprise: 0.3 } },
      fit: { harmonize: true, rhythm: 'complement' },
    },
    {
      id: 'follow',
      title: r.kind === 'arp' || r.kind === 'melody' ? 'Ride the arp' : 'Lock to the chord rhythm',
      why:
        r.kind === 'arp' || r.kind === 'melody'
          ? 'Vocal slices are triggered by the MIDI itself – same rhythm, its notes become playback-rate pitches – a vocal double of your arp.'
          : 'Chops are pulled onto the steps where your chords hit, so the vocal locks to the progression’s groove.',
      settings:
        r.kind === 'arp' || r.kind === 'melody'
          ? { ...base, mode: 'midi' as ComposeMode, direction: 'dance' as Direction }
          : { ...base, mode: 'rhythmic' as ComposeMode, direction: 'dance' as Direction, feel: 'tight' as RhythmFeel, controls: { recognisability: 0.5, repetition: 0.8, fragmentation: 0.5, space: 0.35, melodicMovement: 0.3, surprise: 0.15 } },
      fit: { harmonize: true, rhythm: 'follow' },
    },
    {
      id: 'ghost',
      title: 'Ghost layer under the progression',
      why: `Sparse sustained fragments enter on chord changes and are tuned to the chord underneath – texture for ${slowFeel ? 'a slow, drain-style' : 'an atmospheric'} section.`,
      settings: { ...base, mode: 'ghost', direction: slowFeel ? 'ambient' : 'ethereal', feel: 'sparse', phraseBars: Math.max(2, phraseBars), controls: { recognisability: 0.2, repetition: 0.6, fragmentation: 0.15, space: 0.85, melodicMovement: 0.2, surprise: 0.2 } },
      fit: { harmonize: true, rhythm: 'off' },
    },
  ];
  if (fast || busy)
    recipes.push({
      id: 'micro',
      title: 'Glitch fills between the notes',
      why: 'Tiny stutters and retriggers that only occupy the beat’s free sixteenths – hyperpop/glitch energy without masking your synths.',
      settings: { ...base, mode: 'microchop', direction: 'glitch', feel: 'energetic', controls: { recognisability: 0.2, repetition: 0.55, fragmentation: 0.9, space: 0.45, melodicMovement: 0.5, surprise: 0.6 } },
      fit: { harmonize: true, rhythm: 'complement' },
    });
  if (opts.sources >= 2)
    recipes.push({
      id: 'conversation',
      title: 'Two voices answering each other',
      why: 'Call and response between two of your recordings, phrased in the loop’s bar length and tuned to the chords.',
      settings: { ...base, mode: 'conversation', direction: slowFeel ? 'ethereal' : 'dance', relation: 'call-response' },
      fit: { harmonize: true, rhythm: 'complement' },
    });
  return recipes;
}

/** Arrangement length that tiles the loop and gives the form room (8–16 bars). */
export function arrangementBarsFor(b: BeatContext) {
  const loopBars = Math.max(1, Math.round(b.lengthTicks / barTicks(b.timeSig)));
  return clamp(loopBars * Math.max(1, Math.ceil(8 / loopBars)), 1, 32);
}

export const DEFAULT_FIT: BeatFit = { harmonize: true, rhythm: 'complement', preview: true, previewGain: -12 };

export { PPQ };
