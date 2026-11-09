import type { Motif, MotifNote, MotifProtection } from '../types';
import type { Rng } from '../rng';
import type { Ctx } from './context';
import { semisFor, pickByPitch, naturalTicks, cloneNotes } from './context';
import type { Material } from './material';
import { describeMaterial } from './material';
import { applyDensity, chooseBarCells, parseCell, euclid } from './rhythm';
import { contourAt, type Contour } from './theory';
import { clamp } from '../time';

/**
 * Vocal motif intelligence: build a central motif (rhythm + slice identity +
 * contour), then develop it with musically meaningful transformations.
 */
export type MotifKind = 'melodic' | 'rhythmic' | 'ghost' | 'micro';

export function createMotif(ctx: Ctx, kind: MotifKind, id = 'motif-main', pool?: Material[]): Motif {
  const rng = ctx.rng(`motif:${kind}:${id}`);
  const { prof, c } = ctx;
  const hook = pool ?? ctx.cast.hook;
  const support = pool ?? ctx.cast.support;
  const notes: MotifNote[] = [];
  let span = ctx.bar;

  if (kind === 'ghost') {
    span = ctx.bar * Math.min(2, ctx.phraseBars) * (prof.stride >= 4 ? 1 : 1);
    const count = clamp(Math.round(2 + (1 - c.space) * 2 + rng.float(-0.5, 0.8)), 1, 4);
    const pads = pool ?? [...ctx.cast.pad, ...hook];
    let t = rng.chance(0.5) ? 0 : ctx.beat * rng.int(1, 2);
    for (let i = 0; i < count && t < span; i++) {
      const m = pads[i % pads.length];
      const nat = naturalTicks(ctx, m);
      const len = Math.min(nat, span - t);
      notes.push({ tick: t, length: len, sliceId: m.slice.id, semitones: semisFor(ctx, m, i === count - 1 ? -1 : 0), offset: 0, reverse: rng.chance(prof.reverse * 0.6), accent: i === 0 ? 1 : 0.4 });
      t += Math.max(len + ctx.beat * (1 + Math.round(c.space * 3)), ctx.beat * 2);
      t = Math.round(t / ctx.step) * ctx.step;
    }
    return { id, name: 'Ghost motif', span, notes, protection: 'develop', important: false };
  }

  // Rhythm: one bar from two related cells (stride stretches cells for slower feels).
  const stride = kind === 'micro' || kind === 'rhythmic' ? 1 : prof.stride >= 2 ? 2 : 1;
  const cellsPerBar = Math.max(1, Math.round(ctx.stepsPerBar / (8 * stride)));
  span = ctx.bar * (stride * cellsPerBar * 8 > ctx.stepsPerBar ? 2 : 1);
  if (kind === 'melodic' && prof.stride >= 2 && ctx.phraseBars >= 2 && c.repetition < 0.75) span = ctx.bar * 2;
  const cells: string[] = [];
  const totalCells = Math.max(1, Math.round(span / ctx.step / (8 * stride)));
  const [a, b] = kind === 'micro' ? [euclid(rng.int(3, 5), 8, rng.int(0, 3)), euclid(rng.int(3, 6), 8, rng.int(0, 5))] : chooseBarCells(rng, ctx.feel, ctx.s.complexity, c.surprise);
  for (let i = 0; i < totalCells; i++) cells.push(applyDensity(rng, i % 2 === 0 ? a : b, prof.density));
  let hits = cells.flatMap((cell, i) => parseCell(cell, i * 8).map((h) => ({ ...h, step: h.step * stride, len: h.len * stride })));
  if (!hits.length) hits = [{ step: 0, len: 2, accent: true }];
  // Deliberate gap before the important final word (ethereal/emotional tendency).
  if (kind === 'melodic' && hits.length >= 4 && rng.chance(prof.gaps * 0.8)) {
    hits.splice(hits.length - 2, 1);
  }
  const contour = rng.pick(prof.contours) as Contour;
  const movement = 0.4 + c.melodicMovement * 1.6;
  const maxDeg = Math.max(1, Math.round(4 * movement));
  const spanSteps = Math.round(span / ctx.step);
  const totalHits = hits.length;
  // Slice identity: the hook carries strong beats; contrast slices answer on weak beats.
  const sliceFor = (i: number, accent: boolean, degree: number): Material => {
    const isLast = i === totalHits - 1;
    if (kind === 'melodic' && isLast && totalHits > 2 && rng.chance(0.65)) return ctx.cast.ending;
    if (kind === 'melodic' && !ctx.s.transpose) return pickByPitch([...hook, ...support], degree, maxDeg);
    if (kind === 'rhythmic' || kind === 'micro') {
      if (accent) return hook[0];
      return rng.chance(c.repetition) ? hook[0] : rng.pick([...hook.slice(1), ...ctx.cast.perc, ...support].filter(Boolean));
    }
    if (accent || rng.chance(c.repetition)) return hook[0];
    return rng.pick(hook.length > 1 ? hook.slice(1) : support);
  };
  hits.forEach((h, i) => {
    const t = totalHits > 1 ? i / (totalHits - 1) : 0;
    const degree = kind === 'melodic' ? contourAt(contour, t, movement) : kind === 'rhythmic' && h.accent && rng.chance(c.melodicMovement * 0.6) ? rng.pick([2, 4, -1]) : 0;
    const m = sliceFor(i, h.accent, degree);
    const nextStep = i + 1 < hits.length ? hits[i + 1].step : spanSteps;
    const room = (nextStep - h.step) * ctx.step;
    const semis = semisFor(ctx, m, degree);
    const nat = naturalTicks(ctx, m, semis);
    let len: number;
    if (kind === 'micro') len = Math.min(nat, ctx.step);
    else if (kind === 'rhythmic') len = Math.min(nat, Math.max(ctx.step, Math.round(room * (0.5 + prof.sustain * 0.5))));
    else len = Math.min(nat, prof.sustain > 0.5 || i === totalHits - 1 ? Math.max(room, h.len * ctx.step) : Math.max(ctx.step, h.len * ctx.step));
    // Fragmented hooks use partial slices (microchops starting inside the slice).
    const offset = kind !== 'melodic' && m.dur > 0.25 && rng.chance(c.fragmentation * 0.5) ? Math.round((m.slice.end - m.slice.start) * rng.pick([0, 0.25, 0.5])) : 0;
    notes.push({ tick: h.step * ctx.step, length: Math.max(ctx.step / 2, len), sliceId: m.slice.id, semitones: semis, offset, reverse: false, accent: h.accent ? 1 : 0.4 });
  });
  if (kind === 'micro') {
    // A fixed stutter vocabulary gives the microchop piece its identity.
    for (const n of notes) {
      if (n.accent > 0.5 && rng.chance(0.4 + ctx.prof.stutter * 0.4)) n.length = ctx.step / 2;
    }
  }
  const name = `${kind === 'melodic' ? 'Melodic' : kind === 'micro' ? 'Microchop' : 'Rhythmic'} hook on ${describeMaterial(ctx.matById.get(notes[0]?.sliceId)!)}`;
  return { id, name, span, notes, protection: 'develop', important: false };
}

/** Number of leading notes treated as the motif's protected "head" under 'develop'. */
function headSize(m: Motif) {
  return Math.min(2, m.notes.length);
}

export type DevOp =
  | 'repeat'
  | 'vary-ending'
  | 'replace-one'
  | 'shift-one'
  | 'insert-rest'
  | 'fragment'
  | 'shorten'
  | 'extend'
  | 'displace'
  | 'reverse-some'
  | 'densify'
  | 'simplify'
  | 'transpose';

/** Apply one development operation. Respects the motif's protection level. */
export function develop(ctx: Ctx, rng: Rng, m: Motif, op: DevOp, protection: MotifProtection = m.protection): Motif {
  if (protection === 'preserve' || op === 'repeat') return m;
  const notes = cloneNotes(m.notes);
  const head = protection === 'develop' ? headSize(m) : 0;
  const editable = notes.map((_, i) => i).filter((i) => i >= head);
  const pickEditable = () => (editable.length ? rng.pick(editable) : -1);
  const last = notes.length - 1;
  const mat = (id: string) => ctx.matById.get(id);
  switch (op) {
    case 'vary-ending': {
      if (last < head || last < 0) break;
      const n = notes[last];
      const alt = rng.chance(0.5) ? ctx.cast.ending : rng.pick([...ctx.cast.support, ...ctx.cast.hook]);
      n.sliceId = alt.slice.id;
      n.semitones = semisFor(ctx, alt, rng.pick([-2, -1, 1, 3]));
      n.length = Math.min(Math.max(n.length, ctx.beat), m.span - n.tick);
      n.offset = 0;
      break;
    }
    case 'replace-one': {
      const i = pickEditable();
      if (i < 0) break;
      const alt = rng.pick([...ctx.cast.support, ...ctx.cast.hook].filter((x) => x.slice.id !== notes[i].sliceId).concat(ctx.cast.support[0]));
      notes[i].sliceId = alt.slice.id;
      notes[i].semitones = semisFor(ctx, alt, rng.int(-1, 2));
      notes[i].offset = 0;
      break;
    }
    case 'shift-one': {
      const i = pickEditable();
      if (i < 0) break;
      const d = rng.chance(0.5) ? ctx.step : -ctx.step;
      const t = notes[i].tick + d;
      const prev = notes[i - 1]?.tick ?? -1;
      const next = notes[i + 1]?.tick ?? m.span;
      if (t > prev && t < next) notes[i].tick = t;
      break;
    }
    case 'insert-rest': {
      if (editable.length < 1 || notes.length < 3) break;
      const i = pickEditable();
      notes.splice(i, 1);
      break;
    }
    case 'fragment': {
      const keep = Math.max(1, Math.ceil(notes.length / 2));
      const frag = notes.slice(0, keep);
      const fragSpan = Math.max(ctx.beat, Math.ceil(((frag[frag.length - 1].tick + frag[frag.length - 1].length) / ctx.beat)) * ctx.beat);
      const out: MotifNote[] = [];
      for (let t = 0; t + 1 < m.span; t += fragSpan) for (const n of frag) if (t + n.tick < m.span) out.push({ ...n, tick: t + n.tick, length: Math.min(n.length, fragSpan - n.tick) });
      return { ...m, notes: out };
    }
    case 'shorten':
      for (const i of editable) notes[i].length = Math.max(ctx.step / 2, Math.round(notes[i].length * 0.5));
      break;
    case 'extend': {
      const n = notes[last];
      if (!n) break;
      const t = n.tick + Math.max(ctx.step * 2, Math.round(n.length / ctx.step) * ctx.step);
      if (t < m.span - ctx.step) notes.push({ ...n, tick: t, length: Math.min(n.length, m.span - t), accent: 0.4 });
      break;
    }
    case 'displace': {
      const d = ctx.step * 2;
      for (const n of notes) n.tick = (n.tick + d) % m.span;
      notes.sort((a, b) => a.tick - b.tick);
      break;
    }
    case 'reverse-some': {
      const i = pickEditable();
      if (i >= 0) notes[i].reverse = true;
      break;
    }
    case 'densify': {
      // Final gesture becomes a stutter roll that builds toward the next phrase.
      const n = notes[last];
      if (!n) break;
      const startT = Math.max(n.tick, m.span - ctx.beat);
      const rollStep = ctx.step / (rng.chance(0.5) ? 2 : 1);
      if (last >= head) notes.splice(last, 1);
      const src = notes[0] ?? n;
      for (let t = startT, k = 0; t < m.span; t += rollStep, k++)
        notes.push({ ...src, tick: t, length: rollStep * 0.8, accent: k === 0 ? 0.8 : 0.3 + (k / 8) * 0.5, semitones: src.semitones + (ctx.s.transpose && rng.chance(0.5) ? Math.min(7, k) : 0) });
      break;
    }
    case 'simplify': {
      const kept = notes.filter((n, i) => i < Math.max(1, head) || n.accent > 0.5 || n.tick % ctx.beat === 0);
      for (let i = 0; i < kept.length; i++) {
        const next = kept[i + 1]?.tick ?? m.span;
        const nat = naturalTicks(ctx, mat(kept[i].sliceId), kept[i].semitones);
        kept[i].length = Math.min(nat, next - kept[i].tick);
      }
      return { ...m, notes: kept };
    }
    case 'transpose': {
      if (!ctx.s.transpose) break;
      const up = rng.pick([2, 3, -2]);
      for (const i of editable.length ? editable : notes.map((_, k) => k)) {
        notes[i].semitones = clamp(semisFor(ctx, mat(notes[i].sliceId), 0) + (notes[i].semitones - semisFor(ctx, mat(notes[i].sliceId), 0)) + up, -12, 12);
      }
      break;
    }
  }
  notes.sort((a, b) => a.tick - b.tick);
  return { ...m, notes };
}

/** A substantial transformation used for 'transform' protection. */
export function transformMotif(ctx: Ctx, rng: Rng, m: Motif): Motif {
  let out = develop(ctx, rng, m, 'displace', 'transform');
  out = develop(ctx, rng, out, 'replace-one', 'transform');
  out = develop(ctx, rng, out, rng.pick(['fragment', 'reverse-some', 'transpose'] as DevOp[]), 'transform');
  return { ...out, name: `${m.name} (transformed)` };
}

/**
 * Answer phrase for call-and-response: imitates or complements the call's rhythm
 * with contrasting slices and a resolving contour.
 */
export function answerMotif(ctx: Ctx, rng: Rng, call: Motif, pool: Material[], id: string, style: 'imitate' | 'complement' = rng.chance(0.5) ? 'imitate' : 'complement'): Motif {
  const notes: MotifNote[] = [];
  if (style === 'imitate') {
    call.notes.forEach((n, i) => {
      const m = pool[i % pool.length];
      const deg = i === call.notes.length - 1 ? -2 : -contourAt('arch', i / Math.max(1, call.notes.length - 1), 1);
      notes.push({ ...n, sliceId: m.slice.id, semitones: semisFor(ctx, m, deg), offset: 0, reverse: false });
    });
  } else {
    // place hits in the call's rests on an 8th grid
    const occupied = new Set(call.notes.map((n) => Math.round(n.tick / ctx.step)));
    const steps = Math.round(call.span / ctx.step);
    let k = 0;
    for (let s = 1; s < steps; s += 2) {
      if (occupied.has(s) || occupied.has(s - 1)) continue;
      if (!rng.chance(0.55 + ctx.prof.density * 0.3)) continue;
      const m = pool[k % pool.length];
      notes.push({ tick: s * ctx.step, length: Math.min(naturalTicks(ctx, m), ctx.step * 2), sliceId: m.slice.id, semitones: semisFor(ctx, m, k % 2 ? 0 : 2), offset: 0, reverse: false, accent: k === 0 ? 1 : 0.4 });
      k++;
    }
    if (!notes.length) {
      const m = pool[0];
      notes.push({ tick: call.span / 2, length: Math.min(naturalTicks(ctx, m), call.span / 2), sliceId: m.slice.id, semitones: semisFor(ctx, m, -1), offset: 0, reverse: false, accent: 1 });
    }
  }
  return { id, name: `Answer (${style})`, span: call.span, notes, protection: 'develop', important: false };
}

/** Derive a motif from existing events (e.g. first bar of the lead track). */
export function motifFromEvents(
  events: { tick: number; length: number; sliceId: string; semitones: number; offset: number; reverse: boolean; velocity: number }[],
  id: string,
  name: string,
  span?: number,
): Motif | null {
  if (!events.length) return null;
  const sorted = events.slice().sort((a, b) => a.tick - b.tick);
  const t0 = sorted[0].tick;
  const end = Math.max(...sorted.map((e) => e.tick + e.length));
  return {
    id,
    name,
    span: span ?? Math.max(1, end - t0),
    notes: sorted.map((e) => ({ tick: e.tick - t0, length: e.length, sliceId: e.sliceId, semitones: e.semitones, offset: e.offset, reverse: e.reverse, accent: e.velocity > 0.85 ? 1 : 0.4 })),
    protection: 'preserve',
    important: true,
  };
}

/** Signature used to verify motif preservation in tests and metrics. */
export function motifSignature(m: Pick<Motif, 'notes'>): string {
  return m.notes.map((n) => `${n.tick}:${n.sliceId}:${n.semitones}:${n.reverse ? 'r' : ''}`).join('|');
}
