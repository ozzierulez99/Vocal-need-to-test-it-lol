import type { CreativeControls, GeneratorSettings, Role, RhythmFeel, Motif, MotifNote, BeatContext } from '../types';
import { PPQ } from '../types';
import { Rng, stream } from '../rng';
import type { DirectionProfile } from './directions';
import { effectiveProfile } from './directions';
import type { Cast, Material } from './material';
import { SCALES, degreeToSemis, quantizeToScale, transposeToTarget } from './theory';
import { ticksPerBar, ticksPerBeat, clamp } from '../time';

/** A generated note before it becomes a SeqEvent on a track. */
export interface Note {
  tick: number;
  length: number;
  sliceId: string;
  semitones: number;
  offset: number;
  reverse: boolean;
  gain: number;
  pan: number;
  velocity: number;
  fadeIn: number;
  fadeOut: number;
  gesture?: string;
  motifId?: string;
  /** chord-arp index: resolved to a chord tone when the note is placed */
  arp?: number;
  /** hook-scale step the note was written on */
  step?: number;
  glideIn?: [number, number];
  glideOut?: [number, number];
  align?: boolean;
}

export interface Ctx {
  s: GeneratorSettings;
  c: CreativeControls;
  prof: DirectionProfile;
  feel: RhythmFeel;
  bpm: number;
  timeSig: [number, number];
  beat: number;
  bar: number;
  /** one sixteenth */
  step: number;
  stepsPerBar: number;
  bars: number;
  phraseBars: number;
  rng: (name: string) => Rng;
  mats: Material[];
  matById: Map<string, Material>;
  cast: Cast;
  scale: number[];
  log: string[];
  /** Hint for the lead writer: leave the second half of phrases for a response. */
  leaveAnswerSpace: boolean;
  /** Optional beat context of the user's song (“fit to my beat”). */
  song?: BeatContext;
  /** Semitone steps of the scale the hook is written on (often the pentatonic subset). */
  hookSteps: number[];
  /** How far above/below the voice's natural pitch the lead sits (semitones). */
  lift: number;
  /** Half-time phrasing: hook rhythms are stretched to twice the length. */
  half: boolean;
}

export function makeCtx(
  s: GeneratorSettings,
  bpm: number,
  timeSig: [number, number],
  mats: Material[],
  cast: Cast,
  beat?: BeatContext,
): Ctx {
  const c = s.controls;
  const prof = effectiveProfile(s.direction, c);
  const bar = ticksPerBar(timeSig);
  return {
    s,
    c,
    prof,
    feel: s.feel ?? prof.defaultFeel,
    bpm,
    timeSig,
    beat: ticksPerBeat(timeSig),
    bar,
    step: PPQ / 4,
    stepsPerBar: Math.round(bar / (PPQ / 4)),
    bars: Math.max(1, s.bars),
    phraseBars: clamp(Math.round(s.phraseBars || 2), 1, Math.max(1, s.bars)),
    rng: (name: string) => stream(s.seed, name),
    mats,
    matById: new Map(mats.map((m) => [m.slice.id, m])),
    cast,
    scale: SCALES[s.scale] ?? SCALES.minor,
    log: [],
    leaveAnswerSpace: false,
    song: beat,
    hookSteps: hookStepsFor(s.scale, stream(s.seed, 'hookscale').chance(prof.traits.pentatonic)),
    lift: stream(s.seed, 'lift').pick(prof.traits.lifts) + (s.register === 'low' ? -5 : s.register === 'high' ? 5 : 0),
    half: s.timeFeel === 'half' || ((s.timeFeel ?? 'auto') === 'auto' && (beat?.rhythm.feel === 'half' || (beat?.rhythm.feel === undefined && prof.traits.half >= 0.6 && bpm >= 118))),
  };
}

const MINOR_PENTA = [0, 3, 5, 7, 10];
const MAJOR_PENTA = [0, 2, 4, 7, 9];

/** The scale a hook is written on: the key's pentatonic subset, or the full scale. */
export function hookStepsFor(scale: GeneratorSettings['scale'], pentatonic: boolean): number[] {
  if (scale === 'major-pentatonic') return MAJOR_PENTA;
  if (scale === 'minor-pentatonic') return MINOR_PENTA;
  if (!pentatonic) return SCALES[scale] ?? SCALES.minor;
  return scale === 'major' ? MAJOR_PENTA : MINOR_PENTA;
}

/** Semitones above the tonic for a (possibly negative) step index of the hook scale. */
export function hookSemis(steps: number[], idx: number): number {
  const n = steps.length;
  const oct = Math.floor(idx / n);
  return steps[((idx % n) + n) % n] + 12 * oct;
}

/**
 * MIDI pitch of the tonic this voice plays around: the octave of the key root
 * that keeps the melody close to the voice's natural pitch plus the style lift.
 */
export function voiceTonic(ctx: Ctx, mat: Material | undefined): number {
  const natural = mat?.pitch ?? 60;
  const pc = ctx.s.keyRoot ?? ((Math.round(natural) % 12) + 12) % 12;
  const centre = natural + ctx.lift;
  const mid = hookSemis(ctx.hookSteps, Math.floor(ctx.hookSteps.length / 2));
  let best = pc;
  for (let t = pc - 24; t < 128; t += 12) if (Math.abs(t + mid - centre) < Math.abs(best + mid - centre)) best = t;
  return best;
}

/** Transposition (playback rate) that puts this voice exactly on a hook-scale step. */
export function semisForStep(ctx: Ctx, mat: Material | undefined, idx: number): number {
  if (!ctx.s.transpose) return 0;
  if (!mat || mat.pitch === null) return clamp(hookSemis(ctx.hookSteps, idx) + ctx.lift, -14, 14);
  let semis = voiceTonic(ctx, mat) + hookSemis(ctx.hookSteps, idx) - mat.pitch;
  // keep transposition reasonable, but let pitched-up / pitched-down styles reach their register
  const hi = Math.max(14, ctx.lift + 8);
  const lo = Math.min(-14, ctx.lift - 8);
  while (semis > hi) semis -= 12;
  while (semis < lo) semis += 12;
  return Math.round(semis * 100) / 100;
}

/** Stable resting steps of the hook scale (tonic-triad tones). */
export function stableSteps(steps: number[]): number[] {
  const out: number[] = [];
  steps.forEach((st, i) => {
    if (st === 0 || st === 3 || st === 4 || st === 7) out.push(i);
  });
  return out.length ? out : [0];
}

export const ROLE_GAIN: Record<Role, number> = {
  lead: -3,
  response: -5,
  rhythm: -8,
  atmosphere: -11,
  accent: -6,
  transition: -7,
};

export function registerShift(ctx: Ctx): number {
  const r = ctx.s.register === 'low' ? -5 : ctx.s.register === 'high' ? 5 : 0;
  return r + Math.round(ctx.prof.register * 0.6);
}

/**
 * Pitch realisation via playback-rate transposition. Degree is a scale degree
 * relative to the slice's own nearest scale tone (or relative 0 when the slice
 * has no detectable pitch). Returns semitones, clamped to ±12.
 */
export function semisFor(ctx: Ctx, mat: Material | undefined, degree: number): number {
  if (!ctx.s.transpose) return 0;
  const reg = registerShift(ctx);
  if (mat && mat.pitch !== null && ctx.s.keyRoot !== null) {
    const anchor = quantizeToScale(mat.pitch, ctx.s.keyRoot, ctx.scale);
    const target = quantizeToScale(anchor + degreeToSemis(ctx.scale, degree) + reg, ctx.s.keyRoot, ctx.scale);
    return clamp(transposeToTarget(mat.pitch, target, 12), -12, 12);
  }
  return clamp(degreeToSemis(ctx.scale, degree) + reg, -12, 12);
}

/** Without transposition the contour is realised by choosing slices by natural pitch. */
export function pickByPitch(pool: Material[], degree: number, maxDegree: number): Material {
  const pitched = pool.filter((m) => m.pitch !== null).sort((a, b) => a.pitch! - b.pitch!);
  if (pitched.length < 2) return pool[Math.abs(degree) % pool.length];
  const t = clamp(maxDegree > 0 ? degree / maxDegree : 0.5, 0, 1);
  return pitched[Math.round(t * (pitched.length - 1))];
}

export function note(partial: Partial<Note> & { tick: number; sliceId: string }): Note {
  return {
    length: 240,
    semitones: 0,
    offset: 0,
    reverse: false,
    gain: 0,
    pan: 0,
    velocity: 0.8,
    fadeIn: 3,
    fadeOut: 10,
    ...partial,
  };
}

export function motifToNotes(m: Motif, at: number, extra: Partial<Note> = {}): Note[] {
  return m.notes.map((n) =>
    note({
      tick: at + n.tick,
      length: n.length,
      sliceId: n.sliceId,
      semitones: n.semitones,
      offset: n.offset,
      reverse: n.reverse,
      velocity: 0.65 + n.accent * 0.35,
      gain: n.accent > 0.5 ? 0 : -2,
      motifId: m.id,
      gesture: 'motif',
      arp: n.arp,
      step: n.step,
      ...extra,
    }),
  );
}

export function cloneNotes(ns: MotifNote[]): MotifNote[] {
  return ns.map((n) => ({ ...n }));
}

/** Natural duration of a slice in ticks at given transposition. */
export function naturalTicks(ctx: Ctx, mat: Material | undefined, semitones = 0): number {
  if (!mat) return ctx.step;
  const sec = mat.dur / Math.pow(2, semitones / 12);
  return Math.max(1, Math.round((sec * ctx.bpm * PPQ) / 60));
}
