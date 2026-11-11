import type { Motif, MotifNote } from '../types';
import type { Rng } from '../rng';
import type { Ctx } from './context';
import { naturalTicks, semisForStep, stableSteps } from './context';
import type { Material } from './material';
import { describeMaterial } from './material';
import { mutateCell, parseCell, applyDensity, type Hit } from './rhythm';
import { fitHits } from '../beat/fit';
import { clamp } from '../time';

/**
 * Hook grammar. A hook is a rhythm from a proven family, a pitch line built from
 * small cells that repeat with the rhythm (so rhythm and pitch rhyme), and a
 * "voice": usually one clean vowel played like a sampler instrument.
 *
 * Patterns are one 4/4 bar of sixteenths: X = accent, x = note, . = rest.
 */
export const HOOK_RHYTHMS: Record<string, string[]> = {
  // sparse, lots of air – drain / ethereal / emotional
  float: ['X.....x...x.....', 'X...x.....x.....', 'X..x....x.......', 'X.....x.x.......', 'X.x.......x.....', '..X...x...x.....'],
  // catchy pop syncopation
  pop: ['X..x..x.X..x....', 'X.x...x.X...x.x.', 'X..x..X...x.x...', 'X.xx..x.X..x..x.', 'X...x.x.X..x.x..', 'X.x.x..xX.x.....'],
  // 3-3-2 family
  tresillo: ['X..x..x.X..x..x.', 'X..x..x...x.x...', 'X..x..x.X.....x.', 'X..x..X..x..x...'],
  // off-beat pump (the "and" of every beat)
  pump: ['..X...X...X...X.', '..X...x...X..x..', 'x.X...X.x.X...X.', '..X...X...X.x.x.'],
  // running sixteenths / synth-like arps
  arp: ['X.x.x.x.X.x.x.x.', 'XxxxXxxxXxxxXxxx', 'X.xxX.xxX.xxX.xx', 'X..x.x.xX..x.x.x', 'Xx.xXx.xXx.xXx.x'],
  // 2-step shuffle: hits around the beat rather than on it
  garage: ['X..x...x..X..x..', '.x.X..x..x.X....', 'X..x..x...x.X...', 'x..X...x.x..X...', 'X.....x..x.X..x.'],
  // busy, cut-up
  glitch: ['X.xxX..x.xX.x.xx', 'XxX..xXx..X.xX..', 'X..xXx..X.xx.xX.', 'X.x.XxxxX..x.x..'],
  // slow and heavy
  dark: ['X.......x.......', 'X.....x.....x...', 'X...x...........', 'X.........x.....'],
};

/** Pitch cells in hook-scale steps, grouped by how much they move. */
const PITCH_CELLS: Record<string, number[][]> = {
  still: [[0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0]],
  pendulum: [[0, 1, 0, 1], [0, 2, 0, 1], [1, 0, 1, 0], [0, -1, 0, 1]],
  arch: [[0, 1, 2, 1], [0, 2, 3, 2], [0, 1, 2, 0]],
  fall: [[3, 2, 1, 0], [2, 1, 0, 0], [4, 3, 1, 0]],
  rise: [[0, 1, 2, 3], [0, 1, 3, 4]],
  leap: [[0, 3, 2, 1], [0, 4, 3, 1], [0, 0, 3, 2]],
};

function nearestStable(ctx: Ctx, idx: number): number {
  const stable = stableSteps(ctx.hookSteps);
  const n = ctx.hookSteps.length;
  let best = idx;
  let d = Infinity;
  for (let o = -2; o <= 2; o++)
    for (const s of stable) {
      const c = s + o * n;
      if (Math.abs(c - idx) < d) {
        d = Math.abs(c - idx);
        best = c;
      }
    }
  return best;
}

/** A step that sounds unresolved (a "question"): not the tonic, preferably the 2nd/4th/7th area. */
export function questionStep(ctx: Ctx, rng: Rng, near: number): number {
  const n = ctx.hookSteps.length;
  const stable = new Set(stableSteps(ctx.hookSteps));
  const opts = [near - 1, near + 1, near + 2, near - 2].filter((x) => !stable.has(((x % n) + n) % n) || ((x % n) + n) % n !== 0);
  const unstable = opts.filter((x) => !stable.has(((x % n) + n) % n));
  return rng.pick(unstable.length ? unstable : opts.length ? opts : [near + 1]);
}

/** The tonic nearest to a step (an "answer"). */
export function tonicStep(ctx: Ctx, near: number): number {
  const n = ctx.hookSteps.length;
  return Math.round(near / n) * n;
}

export function composeHook(ctx: Ctx, kind: 'melodic' | 'rhythmic', id: string, pool?: Material[]): Motif {
  const rng = ctx.rng(`hook:${kind}:${id}`);
  const { prof, c } = ctx;
  const tr = prof.traits;
  const half = ctx.half && kind === 'melodic';
  const spb = ctx.stepsPerBar;
  // ── rhythm ────────────────────────────────────────────────────────────────
  const families = kind === 'rhythmic' ? tr.rhythms.filter((f) => f !== 'float' && f !== 'dark').concat(['pop']) : tr.rhythms;
  const family = rng.weighted(families, families.map((_, i) => 1 / (i + 1)));
  let pattern = rng.pick(HOOK_RHYTHMS[family] ?? HOOK_RHYTHMS.pop);
  // user feel nudges the family's pattern (complexity/surprise mutate it)
  if (rng.chance(ctx.s.complexity * 0.5 + c.surprise * 0.3)) pattern = mutateCell(rng, pattern, 1 + Math.round(c.surprise * 2));
  // a two-bar hook: bar 2 answers bar 1 (same, varied, or a sibling pattern)
  const twoBar = kind === 'melodic' && !half && ctx.phraseBars >= 2 && rng.chance(0.35 + (1 - c.repetition) * 0.4);
  let bar2 = pattern;
  if (twoBar) bar2 = rng.chance(0.5) ? mutateCell(rng, pattern, 2) : rng.pick(HOOK_RHYTHMS[family] ?? HOOK_RHYTHMS.pop);
  const fit = (p: string) => (p.length === spb ? p : p.length > spb ? p.slice(0, spb) : p.padEnd(spb, '.'));
  const bars = [fit(pattern), ...(twoBar ? [fit(bar2)] : [])].map((p) => applyDensity(rng, p, clamp(prof.density + 0.25, 0.2, 0.95)));
  const stretch = half ? 2 : 1;
  let hits: Hit[] = bars.flatMap((p, b) => parseCell(p, b * spb).map((h) => ({ ...h, step: h.step * stretch, len: h.len * stretch })));
  if (!hits.length) hits = [{ step: 0, len: 2, accent: true }];
  const span = ctx.bar * bars.length * stretch;
  const spanSteps = Math.round(span / ctx.step);
  if (ctx.song && ctx.song.fit.rhythm !== 'off') {
    const f = fitHits(hits, ctx.song, ctx.song.fit.rhythm, ctx.rng(`beatfit:${id}`));
    hits = f.hits;
    if (f.moved || f.dropped) ctx.log.push(`Beat fit (${ctx.song.fit.rhythm === 'follow' ? 'follow the beat' : 'leave room for the beat'}): ${f.moved} hook note(s) moved${f.dropped ? `, ${f.dropped} dropped` : ''}`);
  }
  // deliberate breath before the last note (floating / emotional styles)
  if (kind === 'melodic' && hits.length >= 5 && rng.chance(prof.gaps * 0.5)) hits.splice(hits.length - 2, 1);

  // ── voice ─────────────────────────────────────────────────────────────────
  const hookPool = pool ?? ctx.cast.hook;
  const voice = pool ? pool.slice().sort((a, b) => b.scores.oneshot - a.scores.oneshot)[0] : ctx.cast.voice;
  const mono = kind === 'melodic' ? rng.chance(tr.monoSlice * (0.6 + c.repetition * 0.5)) : false;
  const alt = (pool ?? [...ctx.cast.hook, ...ctx.cast.support]).filter((m) => m.slice.id !== voice.slice.id);
  const sliceFor = (i: number, accent: boolean): Material => {
    if (kind === 'melodic') {
      if (mono || !alt.length) return voice;
      if (i === hits.length - 1 && hits.length > 2 && rng.chance(0.5)) return pool ? rng.pick(alt) : ctx.cast.ending;
      return accent || rng.chance(c.repetition) ? voice : rng.pick(alt);
    }
    const main = hookPool[0];
    if (accent) return main;
    return rng.chance(c.repetition) ? main : rng.pick([...hookPool.slice(1), ...(pool ? [] : ctx.cast.perc), ...alt].filter(Boolean).concat(main));
  };

  // ── pitch line ────────────────────────────────────────────────────────────
  const m = c.melodicMovement;
  const famW: [string, number][] = [
    ['still', (1 - m) * 2 + (kind === 'rhythmic' ? 3 : 0)],
    ['pendulum', 1],
    ['arch', 0.5 + m],
    ['fall', 0.5 + m * 0.6 + (prof.contours.includes('descend') ? 0.5 : 0)],
    ['rise', m + (prof.contours.includes('ascend') ? 0.5 : 0)],
    ['leap', m * 1.2 + (prof.contours.includes('leap') ? 0.5 : 0)],
  ];
  const cellFam = rng.weighted(famW.map((f) => f[0]), famW.map((f) => f[1]));
  const cellA = rng.pick(PITCH_CELLS[cellFam]);
  const stable = stableSteps(ctx.hookSteps);
  const base = kind === 'rhythmic' ? 0 : rng.pick([0, 0, stable[1] ?? 0, stable[stable.length - 1] ?? 0]);
  // groups of half a bar share a cell; later groups repeat, shift or answer it
  const groupOf = (h: Hit) => Math.floor(h.step / Math.max(1, (spb / 2) * stretch));
  const groups = Array.from(new Set(hits.map(groupOf)));
  const groupPlan = new Map<number, { cell: number[]; shift: number }>();
  groups.forEach((g, gi) => {
    if (gi === 0) groupPlan.set(g, { cell: cellA, shift: 0 });
    else if (rng.chance(c.repetition * 0.7)) groupPlan.set(g, { cell: cellA, shift: 0 });
    else if (rng.chance(0.5)) groupPlan.set(g, { cell: cellA, shift: rng.pick([1, -1, 2]) });
    else groupPlan.set(g, { cell: rng.pick(PITCH_CELLS[rng.pick(['fall', 'pendulum', 'arch'])]), shift: 0 });
  });
  const counters = new Map<number, number>();
  const steps: number[] = hits.map((h) => {
    const g = groupOf(h);
    const k = counters.get(g) ?? 0;
    counters.set(g, k + 1);
    const { cell, shift } = groupPlan.get(g)!;
    return clamp(base + shift + cell[k % cell.length], -3, ctx.hookSteps.length + 3);
  });
  if (kind === 'rhythmic') {
    // rhythmic hooks sit on one pitch; accents may jump to a stable tone above
    for (let i = 0; i < steps.length; i++) steps[i] = hits[i].accent && i > 0 && rng.chance(m * 0.5) ? rng.pick([stable[stable.length - 1] ?? 0, ctx.hookSteps.length]) : 0;
  }
  // the hook lands somewhere restful so it can loop
  if (kind === 'melodic' && steps.length > 1) steps[steps.length - 1] = nearestStable(ctx, steps[steps.length - 1]);

  // ── notes ─────────────────────────────────────────────────────────────────
  const notes: MotifNote[] = [];
  hits.forEach((h, i) => {
    const mat = sliceFor(i, h.accent);
    const next = i + 1 < hits.length ? hits[i + 1].step : spanSteps;
    const room = (next - h.step) * ctx.step;
    const semis = semisForStep(ctx, mat, steps[i]);
    const nat = naturalTicks(ctx, mat, semis);
    const last = i === hits.length - 1;
    // articulation: staccato styles leave air between notes, legato styles hold until the next one
    const hold = last ? 1 : clamp(1 - tr.staccato * 0.55 + prof.sustain * 0.2, 0.35, 1);
    let len = Math.min(nat, Math.max(ctx.step * 0.75, Math.round((room * hold) / 60) * 60));
    if (kind === 'rhythmic') len = Math.min(nat, Math.max(ctx.step * 0.75, Math.round(room * (0.45 + prof.sustain * 0.4))));
    const offset = kind === 'rhythmic' && mat.dur > 0.25 && rng.chance(c.fragmentation * 0.4) ? Math.round((mat.slice.end - mat.slice.start) * rng.pick([0, 0.25, 0.5])) : 0;
    notes.push({ tick: h.step * ctx.step, length: Math.max(ctx.step / 2, len), sliceId: mat.slice.id, semitones: semis, offset, reverse: false, accent: h.accent ? 1 : 0.4, step: steps[i] });
  });
  const label = kind === 'melodic' ? (mono ? 'Sampler-style hook' : 'Melodic hook') : 'Rhythmic hook';
  ctx.log.push(`Hook: ${family} rhythm${half ? ' in half-time' : ''}, ${kind === 'melodic' ? `${cellFam} pitch cell on ${ctx.hookSteps.length === 5 ? 'the pentatonic' : 'the full scale'}` : 'one pitch with accents'}${ctx.lift ? `, pitched ${Math.abs(ctx.lift)} st ${ctx.lift > 0 ? 'above' : 'below'} the voice` : ''}`);
  return { id, name: `${label} on ${describeMaterial(ctx.matById.get(notes[0].sliceId)!)}`, span, notes, protection: 'develop', important: false };
}

/**
 * Chord-arp hook (needs a beat or a key): running notes whose pitches are
 * chord tones chosen at placement time from the chord underneath.
 */
export function composeArpHook(ctx: Ctx, id: string): Motif {
  const rng = ctx.rng(`arp:${id}`);
  const voice = ctx.cast.voice;
  let pattern = rng.pick(HOOK_RHYTHMS.arp);
  const spb = ctx.stepsPerBar;
  pattern = pattern.length >= spb ? pattern.slice(0, spb) : pattern.padEnd(spb, '.');
  pattern = applyDensity(rng, pattern, clamp(ctx.prof.density + 0.3, 0.3, 0.95));
  let hits = parseCell(pattern, 0);
  if (ctx.song && ctx.song.fit.rhythm === 'complement') hits = fitHits(hits, ctx.song, 'complement', ctx.rng(`beatfit:${id}`)).hits;
  const shape = rng.pick([[0, 1, 2, 3, 2, 1], [0, 1, 2, 1], [0, 2, 1, 3], [3, 2, 1, 0], [0, 1, 2, 3]]);
  const notes: MotifNote[] = hits.map((h, i) => {
    const next = i + 1 < hits.length ? hits[i + 1].step : spb;
    const semis = semisForStep(ctx, voice, 0);
    const len = Math.min(naturalTicks(ctx, voice, semis), Math.max(ctx.step * 0.75, Math.round((next - h.step) * ctx.step * (1 - ctx.prof.traits.staccato * 0.4))));
    return { tick: h.step * ctx.step, length: len, sliceId: voice.slice.id, semitones: semis, offset: 0, reverse: false, accent: h.accent ? 1 : 0.4, step: 0, arp: shape[i % shape.length] };
  });
  ctx.log.push(`Hook: vocal arp – ${describeMaterial(voice)} follows the chord tones (${shape.join('-')})`);
  return { id, name: `Vocal arp on ${describeMaterial(voice)}`, span: ctx.bar, notes, protection: 'develop', important: false };
}
