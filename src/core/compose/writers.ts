import type { Motif } from '../types';
import type { Ctx, Note } from './context';
import { motifToNotes, note, naturalTicks, semisFor, semisForStep, ROLE_GAIN } from './context';
import { PPQ } from '../types';
import type { Section } from './form';
import { develop, answerMotif, createMotif, type DevOp, type MotifKind } from './motif';
import { chooseBarCells, mutateCell, parseCell, applyDensity, swingOffset } from './rhythm';
import type { Material } from './material';
import { describeMaterial } from './material';
import { busyStep, chordChanges } from '../beat/fit';

/** Clip notes into [start, end): drop notes starting outside, shorten overlong ones. */
export function clipNotes(ns: Note[], start: number, end: number): Note[] {
  return ns
    .filter((n) => n.tick >= start && n.tick < end)
    .map((n) => (n.tick + n.length > end ? { ...n, length: Math.max(1, end - n.tick) } : n));
}

function sectionWindow(ctx: Ctx, sec: Section) {
  const start = sec.startBar * ctx.bar;
  const end = start + sec.bars * ctx.bar;
  return { start, end };
}

const VARY_OPS: DevOp[] = ['vary-ending', 'replace-one', 'shift-one', 'insert-rest', 'extend', 'reverse-some', 'transpose'];

/**
 * Lead writer shared by melodic, rhythmic and ghost modes: states the central
 * motif, then develops it section by section following the form plan.
 */
export function writeMotifLead(ctx: Ctx, form: Section[], motif: Motif, kind: MotifKind): Note[] {
  const out: Note[] = [];
  const rng = ctx.rng('lead');
  const prot = motif.protection;
  let bMotif: Motif | null = null;
  for (const sec of form) {
    const { start, end } = sectionWindow(ctx, sec);
    const halfLen = Math.max(ctx.bar / 2, Math.floor(sec.bars / 2) * ctx.bar || ctx.bar / 2);
    // verse beds answer the main vocal: the chops only speak in the second half of each phrase
    const verse = (ctx.s.purpose ?? 'hook') === 'verse';
    const winStart = verse ? start + halfLen : start;
    const winEnd = ctx.leaveAnswerSpace && !verse ? start + halfLen : end;
    let m: Motif = motif;
    let gesture = 'motif';
    switch (sec.op) {
      case 'vary': {
        const ops = rng.shuffle(VARY_OPS).slice(0, 1 + (rng.chance(ctx.c.surprise) ? 1 : 0));
        for (const op of ops) m = develop(ctx, rng, m, op, prot);
        gesture = 'motif-var';
        ctx.log.push(`${sec.label}: motif varied (${ops.join(', ')})`);
        break;
      }
      case 'contrast': {
        if (kind === 'melodic' && ctx.s.transpose && rng.chance(0.5)) {
          m = develop(ctx, rng, develop(ctx, rng, motif, 'transpose', prot === 'preserve' ? 'develop' : prot), 'vary-ending', 'develop');
          if (prot === 'preserve') m = motif;
          ctx.log.push(`${sec.label}: melodic sequence – motif moved to a new scale step`);
        } else {
          bMotif = bMotif ?? (rng.chance(0.5) ? answerMotif(ctx, rng, motif, ctx.cast.support, 'motif-b') : createMotif(ctx, kind, 'motif-b', [...ctx.cast.support, ...ctx.cast.hook.slice(1)]));
          m = bMotif;
          ctx.log.push(`${sec.label}: contrasting idea built from ${ctx.cast.support.map(describeMaterial).slice(0, 2).join(' & ')}`);
        }
        gesture = 'contrast';
        break;
      }
      case 'fragment':
        m = develop(ctx, rng, motif, 'fragment', prot);
        gesture = 'fragment';
        ctx.log.push(`${sec.label}: motif fragmented into its opening cell`);
        break;
      case 'simplify':
        m = develop(ctx, rng, motif, 'simplify', prot);
        gesture = 'simplify';
        ctx.log.push(`${sec.label}: gradually simplified`);
        break;
      case 'displace':
        m = develop(ctx, rng, motif, 'displace', prot);
        gesture = 'displaced';
        ctx.log.push(`${sec.label}: motif shifted by an eighth`);
        break;
      case 'break':
        m = prot === 'preserve' ? motif : develop(ctx, rng, motif, 'simplify', prot);
        gesture = 'break';
        break;
      case 'build':
        gesture = 'build';
        break;
      case 'return':
        gesture = 'motif';
        if (sec.index > 0) ctx.log.push(`${sec.label}: original motif returns`);
        break;
    }
    const reps = Math.max(1, Math.ceil((winEnd - winStart) / Math.max(1, m.span)));
    for (let r = 0; r < reps; r++) {
      const at = winStart + r * m.span;
      if (at >= winEnd) break;
      let inst = m;
      if (sec.op === 'break' && r > 0) break; // leave the rest of the phrase empty
      const lastRep = r === reps - 1;
      if (lastRep && reps > 1 && sec.op !== 'return' && sec.op !== 'state') inst = develop(ctx, rng, inst, 'vary-ending', prot);
      if (sec.op === 'state' && lastRep && reps > 1 && rng.chance(0.6)) inst = develop(ctx, rng, inst, 'vary-ending', prot);
      if (sec.op === 'build' && lastRep) inst = develop(ctx, rng, inst, 'densify', prot === 'preserve' ? 'develop' : prot);
      // the very last statement comes home to the tonic so the part resolves (and loops)
      if (sec.final && lastRep && sec.op !== 'build' && sec.op !== 'break') inst = develop(ctx, rng, inst, 'resolve', prot);
      const g = inst === motif ? 'motif' : gesture === 'motif' ? 'motif-var' : gesture;
      const ns = motifToNotes(inst, at, { gesture: g, motifId: inst.id === motif.id ? motif.id : undefined });
      out.push(...clipNotes(ns, at, winEnd));
    }
    if (sec.op === 'build') ctx.log.push(`${sec.label}: builds toward a stutter roll`);
    if (sec.op === 'break') ctx.log.push(`${sec.label}: breakdown – one statement then space`);
  }
  // Final gesture: let the last note ring into the end where there is room.
  const final = out[out.length - 1];
  if (final) {
    const songEnd = ctx.bars * ctx.bar;
    const mat = ctx.matById.get(final.sliceId);
    final.length = Math.max(final.length, Math.min(songEnd - final.tick, naturalTicks(ctx, mat, final.semitones)));
    final.fadeOut = Math.max(final.fadeOut, 40);
  }
  return out.map((n) => ({ ...n, gain: n.gain + ROLE_GAIN.lead, fadeIn: Math.max(n.fadeIn, ctx.prof.fadeIn), fadeOut: Math.max(n.fadeOut, ctx.prof.fadeOut) }));
}

/** Response layer: answers the lead in the space it leaves. */
export function writeResponse(ctx: Ctx, form: Section[], motif: Motif, lead: Note[]): Note[] {
  const rng = ctx.rng('response');
  const out: Note[] = [];
  const pool = ctx.cast.support.length ? ctx.cast.support : ctx.cast.hook;
  const answer = answerMotif(ctx, rng, motif, pool, 'motif-answer');
  ctx.log.push(`Response: ${answer.name.toLowerCase()} using ${pool.map(describeMaterial).slice(0, 2).join(' & ')}`);
  form.forEach((sec, i) => {
    if (sec.op === 'break') return;
    const { start, end } = sectionWindow(ctx, sec);
    let wStart: number;
    if (ctx.leaveAnswerSpace) wStart = start + Math.max(ctx.bar / 2, Math.floor(sec.bars / 2) * ctx.bar || ctx.bar / 2);
    else {
      // longest gap in the lead inside this section
      const ns = lead.filter((n) => n.tick >= start && n.tick < end).sort((a, b) => a.tick - b.tick);
      let best = { s: start, len: 0 };
      let cur = start;
      for (const n of ns) {
        if (n.tick - cur > best.len) best = { s: cur, len: n.tick - cur };
        cur = Math.max(cur, n.tick + n.length);
      }
      if (end - cur > best.len) best = { s: cur, len: end - cur };
      if (best.len < ctx.beat * 2) return;
      wStart = Math.ceil(best.s / ctx.beat) * ctx.beat;
    }
    let m = answer;
    if (sec.op === 'vary' || sec.op === 'build') m = develop(ctx, rng, m, rng.pick(['vary-ending', 'shift-one', 'replace-one'] as DevOp[]), 'develop');
    if (sec.final) m = develop(ctx, rng, m, 'vary-ending', 'develop');
    const reps = Math.max(1, Math.floor((end - wStart) / m.span));
    for (let r = 0; r < reps; r++) out.push(...clipNotes(motifToNotes(m, wStart + r * m.span, { gesture: 'answer', motifId: undefined }), wStart, end));
    void i;
  });
  return out.map((n) => ({ ...n, gain: n.gain + ROLE_GAIN.response, pan: 0.3, fadeOut: Math.max(n.fadeOut, ctx.prof.fadeOut) }));
}

/** Rhythmic accompaniment: a steady complementary ostinato from percussive fragments. */
export function writeRhythm(ctx: Ctx, form: Section[], lead: Note[]): Note[] {
  const rng = ctx.rng('rhythm');
  const out: Note[] = [];
  const [a, b] = chooseBarCells(rng, ctx.feel === 'sparse' ? 'tight' : ctx.feel, ctx.s.complexity, ctx.c.surprise);
  const percs = ctx.cast.perc;
  const order = [0, 1, 0, 0, 1, 0, 1, 1].map((i) => percs[i % percs.length]);
  const leadOn = new Set(lead.map((n) => Math.round(n.tick / ctx.step)));
  ctx.log.push(`Rhythm layer: ostinato ${a}|${b} on ${percs.map(describeMaterial).slice(0, 2).join(' / ')}`);
  for (const sec of form) {
    if (sec.energy < 0.3) continue;
    const secB = sec.op === 'vary' || sec.op === 'contrast' ? mutateCell(ctx.rng(`rhythm:${sec.index}`), b, 1) : b;
    for (let bar = sec.startBar; bar < sec.startBar + sec.bars; bar++) {
      const cells = [a, secB];
      if (sec.op === 'build' && bar === sec.startBar + sec.bars - 1) cells[1] = 'xxxxXxXx';
      let k = 0;
      cells.forEach((cell, ci) => {
        const dens = applyDensity(rng, cell, Math.min(0.95, ctx.prof.density * (0.6 + sec.energy * 0.6)));
        for (const h of parseCell(dens, ci * 8)) {
          const absStep = bar * ctx.stepsPerBar + h.step;
          if (h.step >= ctx.stepsPerBar) continue;
          if (leadOn.has(absStep) && !h.accent) continue; // leave room for the hook
          if (ctx.song && ctx.song.fit.rhythm === 'complement' && !h.accent && busyStep(ctx.song, h.step) >= 0.5) continue; // and for the beat
          if (ctx.song && ctx.song.fit.rhythm === 'follow' && !h.accent && busyStep(ctx.song, h.step) < 0.25) continue;
          const m = order[k++ % order.length];
          const tick = absStep * ctx.step; // swing is applied by the sequence groove at playback/export
          out.push(note({ tick, length: Math.min(naturalTicks(ctx, m), ctx.step * Math.max(1, h.len)), sliceId: m.slice.id, semitones: 0, gain: ROLE_GAIN.rhythm + (h.accent ? 0 : -3), velocity: h.accent ? 0.9 : 0.6, pan: k % 2 ? -0.2 : 0.2, fadeOut: 8, gesture: 'groove' }));
        }
      });
    }
  }
  return out;
}

/** Atmospheric layer: sparse, sustained, overlapping fragments with long fades. */
export function writeAtmosphere(ctx: Ctx, form: Section[], opts: { delayBars?: number; variant?: number; pool?: Material[] } = {}): Note[] {
  const rng = ctx.rng(`atmos:${opts.variant ?? 0}`);
  const out: Note[] = [];
  const pads = opts.pool ?? [...ctx.cast.pad, ...ctx.cast.breath.slice(0, 1)];
  const spacing = Math.max(1, Math.round(1 + ctx.c.space * 2.5 + (opts.variant ?? 0)));
  const total = ctx.bars * ctx.bar;
  let t = (opts.delayBars ?? 0) * ctx.bar + (opts.variant ? ctx.beat * rng.int(1, 3) : 0);
  let i = 0;
  const lowShift = ctx.s.direction === 'ambient' || ctx.s.register === 'low' ? rng.pick([-12, -7, -5]) : 0;
  while (t < total) {
    const sec = form.find((s) => t >= s.startBar * ctx.bar && t < (s.startBar + s.bars) * ctx.bar);
    const m = pads[Math.floor(i / 2) % pads.length]; // slow rotation: each fragment returns
    const semis = ctx.s.transpose ? Math.max(-12, semisFor(ctx, m, i % 3 === 2 ? -1 : 0) + lowShift) : lowShift && rng.chance(0.5) ? lowShift : 0;
    const nat = naturalTicks(ctx, m, semis);
    const reverse = rng.chance(ctx.prof.reverse);
    const offset = m.attack > 0.6 && !reverse ? Math.round((m.slice.end - m.slice.start) * 0.15) : 0;
    let tick = t;
    const changes = ctx.song ? chordChanges(ctx.song, total) : [];
    if (reverse) {
      // reverse swell that lands on the next downbeat (or the next chord change of the beat)
      const land = changes.find((c) => c >= t + nat) ?? Math.ceil((t + nat) / ctx.bar) * ctx.bar;
      tick = Math.max(t, land - nat);
    } else if (changes.length) {
      // atmospheric entries arrive with the harmony
      const near = changes.filter((c) => Math.abs(c - t) <= ctx.bar / 2).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
      if (near !== undefined) tick = near;
    }
    if (!sec || sec.energy > 0.2 || rng.chance(0.5)) {
      out.push(note({ tick: Math.round(tick / ctx.step) * ctx.step, length: Math.min(nat, total - tick), sliceId: m.slice.id, semitones: semis, offset, reverse, gain: ROLE_GAIN.atmosphere + rng.float(-2, 1), velocity: 0.5, pan: (i % 2 ? 1 : -1) * (0.3 + rng.float(0, 0.3)), fadeIn: Math.max(ctx.prof.fadeIn, 60) * (reverse ? 3 : 1), fadeOut: Math.max(ctx.prof.fadeOut, 200), gesture: reverse ? 'swell' : 'atmos' }));
    }
    const overlap = rng.chance(ctx.prof.overlap) ? 0.5 : 1;
    t += Math.max(ctx.bar, Math.round(Math.max(nat * overlap, spacing * ctx.bar) / ctx.bar) * ctx.bar);
    i++;
  }
  ctx.log.push(`Atmosphere${opts.variant ? ' B' : ''}: ${out.length} sparse ${lowShift ? `pitched-down (${lowShift} st) ` : ''}fragments${opts.delayBars ? `, delayed entrance at bar ${opts.delayBars + 1}` : ''}`);
  return out;
}

/** Accents at structural points: section downbeats and pickups. */
export function writeAccents(ctx: Ctx, form: Section[]): Note[] {
  const rng = ctx.rng('accent');
  const out: Note[] = [];
  const acc = ctx.cast.accent;
  for (const sec of form) {
    if (sec.op === 'break') continue;
    const s = sec.startBar * ctx.bar;
    const m = acc[sec.index % acc.length];
    out.push(note({ tick: s, length: Math.min(naturalTicks(ctx, m), ctx.beat), sliceId: m.slice.id, gain: ROLE_GAIN.accent, velocity: 1, fadeOut: 15, gesture: 'accent' }));
    if (ctx.prof.accentContrast > 0.5 && !sec.final) {
      const pick = s + sec.bars * ctx.bar - ctx.step * 2;
      if (rng.chance(0.7)) out.push(note({ tick: pick, length: ctx.step * 2, sliceId: acc[(sec.index + 1) % acc.length].slice.id, gain: ROLE_GAIN.accent - 2, velocity: 0.85, fadeOut: 10, gesture: 'pickup' }));
    }
  }
  return out;
}

export interface TransitionResult {
  notes: Note[];
  cuts: { start: number; end: number }[];
  /** boundaries whose preceding lead note should tape-stop */
  tapeStops: number[];
}

/**
 * Fills at section changes, chosen from the style's vocabulary:
 * roll, zipper (accelerating stutter), triplet burst, pitch-rise, tape-stop,
 * reverse swell, breath, echo space, gated pad or a deliberate drop-out.
 */
export function writeTransitions(ctx: Ctx, form: Section[]): TransitionResult {
  const rng = ctx.rng('transition');
  const notes: Note[] = [];
  const cuts: { start: number; end: number }[] = [];
  const tapeStops: number[] = [];
  const voice = ctx.cast.voice;
  const tr = ctx.prof.traits;
  const padLong = ctx.cast.pad.slice().sort((a, b) => b.dur - a.dur)[0];
  const purpose = ctx.s.purpose ?? 'hook';
  const stepSemis = (k: number) => (ctx.s.transpose ? semisForStep(ctx, voice, k) : 0);
  const base = ROLE_GAIN.transition;
  const boundaries = form.slice(1).map((sec) => ({ tick: sec.startBar * ctx.bar, label: sec.label, bar: sec.startBar + 1, energy: sec.energy }));
  // a build ends with a fill into the (imagined) drop
  if (purpose === 'build') boundaries.push({ tick: ctx.bars * ctx.bar, label: 'the drop', bar: ctx.bars + 1, energy: 1 });
  for (const bd of boundaries) {
    const boundary = bd.tick;
    const weights = tr.fills.map((f, i) => {
      let w = 1 / (i + 1);
      if (f === 'cut') w *= 0.4 + ctx.prof.gaps;
      if (f === 'swell') w *= 0.4 + ctx.prof.reverse * 2 + ctx.prof.sustain * 0.4;
      if (f === 'gate' && (!padLong || naturalTicks(ctx, padLong) < ctx.beat * 2)) w = 0;
      if (purpose === 'build' && (f === 'pitchrise' || f === 'zipper' || f === 'roll')) w *= 2.5;
      return w;
    });
    const g = rng.weighted(tr.fills, weights);
    const into = `→ ${bd.label}:`;
    if (g === 'roll') {
      const sub = rng.chance(0.5 + ctx.prof.stutter * 0.3) ? ctx.step / 2 : ctx.step;
      const n = ctx.beat / sub;
      for (let t = boundary - ctx.beat, k = 0; t < boundary; t += sub, k++)
        notes.push(note({ tick: t, length: Math.round(sub * 0.75), sliceId: voice.slice.id, semitones: stepSemis(0), gain: base - 6 + (k * 6) / n, velocity: 0.5 + (k * 0.4) / n, fadeIn: 1, fadeOut: 3, gesture: 'roll', align: false }));
      ctx.log.push(`${into} stutter roll into bar ${bd.bar}`);
    } else if (g === 'zipper') {
      // sixteenths → thirty-seconds → sixty-fourths across the last beat
      const start = boundary - ctx.beat;
      const plan: [number, number][] = [[0, ctx.step], [ctx.step, ctx.step], [ctx.step * 2, ctx.step / 2], [ctx.step * 2.5, ctx.step / 2], ...[0, 1, 2, 3].map((i) => [ctx.step * 3 + (i * ctx.step) / 4, ctx.step / 4] as [number, number])];
      plan.forEach(([dt, len], k) => notes.push(note({ tick: Math.round(start + dt), length: Math.max(20, Math.round(len * 0.8)), sliceId: voice.slice.id, semitones: stepSemis(0), gain: base - 7 + k * 0.9, velocity: 0.5 + k * 0.06, fadeIn: 1, fadeOut: 2, gesture: 'zipper', align: false })));
      ctx.log.push(`${into} zipper fill (1/16 → 1/32 → 1/64) into bar ${bd.bar}`);
    } else if (g === 'triplet') {
      const sub = PPQ / 6;
      for (let t = boundary - ctx.beat, k = 0; t < boundary - 1; t += sub, k++)
        notes.push(note({ tick: Math.round(t), length: Math.round(sub * 0.8), sliceId: voice.slice.id, semitones: stepSemis(k % 3 === 2 ? 1 : 0), gain: base - 5 + k * 0.6, velocity: k % 3 === 0 ? 0.9 : 0.6, fadeIn: 1, fadeOut: 3, gesture: 'triplet', align: false }));
      ctx.log.push(`${into} triplet burst into bar ${bd.bar}`);
    } else if (g === 'pitchrise') {
      // a rising run up the hook scale over the last two beats
      const start = boundary - ctx.beat * 2;
      for (let k = 0; k < 8; k++)
        notes.push(note({ tick: start + k * ctx.step, length: Math.round(ctx.step * 0.8), sliceId: voice.slice.id, semitones: stepSemis(Math.floor(k / 2) + (k % 2 ? 1 : 0)), gain: base - 8 + k, velocity: 0.5 + k * 0.06, fadeIn: 1, fadeOut: 4, gesture: 'rise', align: false }));
      ctx.log.push(`${into} rising run into bar ${bd.bar}`);
    } else if (g === 'tapestop') {
      tapeStops.push(boundary);
      cuts.push({ start: boundary - ctx.step * 2, end: boundary });
      ctx.log.push(`${into} tape-stop and a breath of silence before bar ${bd.bar}`);
    } else if (g === 'swell') {
      const m = padLong ?? voice;
      const nat = Math.min(naturalTicks(ctx, m), ctx.bar);
      notes.push(note({ tick: boundary - nat, length: nat, sliceId: m.slice.id, reverse: true, gain: base, velocity: 0.6, fadeIn: 200, fadeOut: 5, gesture: 'swell' }));
      ctx.log.push(`${into} reverse swell lands on bar ${bd.bar}`);
    } else if (g === 'gate' && padLong) {
      const m = padLong;
      const rateFrames = (60 / (ctx.bpm * PPQ)) * m.source.sampleRate;
      const start = boundary - ctx.beat * 2;
      'x.xx.xxx'.split('').forEach((c, k) => {
        if (c !== 'x') return;
        notes.push(note({ tick: start + k * ctx.step, length: Math.round(ctx.step * 0.8), sliceId: m.slice.id, offset: Math.round((m.slice.end - m.slice.start) * 0.1 + k * ctx.step * rateFrames), gain: base - 2, velocity: 0.7, fadeIn: 2, fadeOut: 6, gesture: 'gate', align: false }));
      });
      ctx.log.push(`${into} gated vowel into bar ${bd.bar}`);
    } else if (g === 'echo' || g === 'cut') {
      cuts.push({ start: boundary - ctx.beat, end: boundary });
      ctx.log.push(`${into} deliberate silence before bar ${bd.bar}`);
    } else {
      const m = ctx.cast.breath[0];
      const nat = Math.min(naturalTicks(ctx, m), ctx.beat * 2);
      notes.push(note({ tick: boundary - nat, length: nat, sliceId: m.slice.id, gain: base, velocity: 0.5, fadeIn: 40, fadeOut: 60, gesture: 'breath' }));
      ctx.log.push(`${into} breath before bar ${bd.bar}`);
    }
  }
  return { notes: notes.filter((n) => n.tick >= 0 && n.tick < ctx.bars * ctx.bar), cuts, tapeStops };
}

/** Tape-stop: the last note before each boundary falls an octave as it ends. */
export function applyTapeStops(ctx: Ctx, ns: Note[], boundaries: number[]): Note[] {
  if (!boundaries.length || !ctx.s.transpose) return ns;
  const out = ns.map((n) => ({ ...n }));
  for (const b of boundaries) {
    const before = out.filter((n) => n.tick < b - ctx.step * 2 && n.tick >= b - ctx.bar).sort((x, y) => y.tick - x.tick)[0];
    if (!before) continue;
    before.length = Math.max(before.length, Math.min(b - ctx.step * 2 - before.tick, ctx.beat * 2));
    before.glideOut = [-12, 260];
  }
  return out;
}

export function applyCuts(ns: Note[], cuts: { start: number; end: number }[]): Note[] {
  if (!cuts.length) return ns;
  const out: Note[] = [];
  for (const n of ns) {
    const c = cuts.find((c) => n.tick >= c.start && n.tick < c.end);
    if (c) continue;
    const over = cuts.find((c) => n.tick < c.start && n.tick + n.length > c.start);
    out.push(over ? { ...n, length: over.start - n.tick, fadeOut: Math.max(n.fadeOut, 10) } : n);
  }
  return out;
}
