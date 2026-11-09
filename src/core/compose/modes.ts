import type { ConversationRelation, Motif, MidiGuide } from '../types';
import type { Ctx, Note } from './context';
import { note, naturalTicks, semisFor, ROLE_GAIN, motifToNotes } from './context';
import type { Section } from './form';
import type { Material } from './material';
import { castMaterial, describeMaterial } from './material';
import { createMotif, develop, answerMotif, type DevOp } from './motif';
import { clipNotes } from './writers';
import { clamp } from '../time';

/* ------------------------------------------------------------------------ */
/* Phrase reconstruction                                                     */
/* ------------------------------------------------------------------------ */

/** Pick the "words" of the phrase: word-level slices of the main source in source order. */
export function phraseWords(ctx: Ctx): Material[] {
  const bySource = new Map<string, Material[]>();
  for (const m of ctx.mats) {
    if (!bySource.has(m.source.id)) bySource.set(m.source.id, []);
    bySource.get(m.source.id)!.push(m);
  }
  // main source = the one with most word-level material
  let best: Material[] = [];
  for (const list of bySource.values()) {
    const words = list.filter((m) => m.slice.level === 'word');
    const cand = words.length >= 2 ? words : list.filter((m) => m.slice.level === 'syllable').length >= 2 ? list.filter((m) => m.slice.level === 'syllable') : list;
    if (cand.length > best.length) best = cand;
  }
  // de-duplicate overlapping regions (prefer earlier start, non-overlap)
  const sorted = best.slice().sort((a, b) => a.slice.start - b.slice.start);
  const out: Material[] = [];
  for (const m of sorted) if (!out.length || m.slice.start >= out[out.length - 1].slice.end - 64) out.push(m);
  return out.slice(0, 12);
}

export function writePhraseLead(ctx: Ctx, form: Section[], anchorSliceId?: string): { notes: Note[]; anchor: Material; words: Material[] } {
  const rng = ctx.rng('phrase');
  const words = phraseWords(ctx);
  if (!words.length) throw new Error('Phrase reconstruction needs word or syllable slices.');
  // Anchor: user-protected slice, otherwise the most recognisable word.
  const anchor = words.find((w) => w.slice.id === anchorSliceId) ?? words.slice().sort((a, b) => b.scores.hook - a.scores.hook)[0];
  const spanTicks = ctx.phraseBars * ctx.bar;
  // Original timing from source positions, quantised to the grid and fitted to the phrase.
  const sr = words[0].source.sampleRate;
  const t0 = words[0].slice.start;
  const secToTicks = (sec: number) => (sec * ctx.bpm * 960) / 60;
  const rawOnsets = words.map((w) => secToTicks((w.slice.start - t0) / sr));
  const lastEnd = secToTicks((words[words.length - 1].slice.end - t0) / sr);
  const fit = lastEnd > spanTicks * 0.95 ? (spanTicks * 0.95) / lastEnd : 1;
  const grid = ctx.prof.stride >= 2 ? ctx.step * 2 : ctx.step;
  const onsets: number[] = [];
  rawOnsets.forEach((o, i) => {
    let q = Math.round((o * fit) / grid) * grid;
    if (i > 0 && q <= onsets[i - 1]) q = onsets[i - 1] + grid;
    onsets.push(q);
  });
  if (fit < 1) ctx.log.push(`Original phrase timing compressed ×${fit.toFixed(2)} to fit ${ctx.phraseBars} bar(s)`);
  const anchorIdx = words.indexOf(anchor);
  ctx.log.push(`Words in order: ${words.map((w) => w.slice.name).join(' ')} · anchor ${describeMaterial(anchor)}`);
  const out: Note[] = [];
  const place = (seq: (Material | null)[], start: number, gesture: string, opts: { frag?: number; reverseLast?: boolean } = {}) => {
    seq.forEach((w, i) => {
      if (!w || i >= onsets.length) return;
      const at = start + onsets[i];
      const next = i + 1 < onsets.length ? start + onsets[i + 1] : start + spanTicks;
      const nat = naturalTicks(ctx, w);
      const frag = opts.frag ?? 0;
      if (frag > 0 && w.dur > 0.12 && w.slice.id !== anchor.slice.id) {
        // break the word apart: retrigger its opening fragment
        const pieces = 2 + Math.round(frag * 3);
        const pieceLen = Math.max(ctx.step / 2, Math.floor((next - at) / pieces / (ctx.step / 2)) * (ctx.step / 2));
        for (let k = 0; k < pieces && at + k * pieceLen < next; k++) {
          const off = Math.round((w.slice.end - w.slice.start) * (k % 2 === 0 ? 0 : clamp(0.3 * frag, 0, 0.6)));
          out.push(note({ tick: at + k * pieceLen, length: Math.round(pieceLen * 0.8), sliceId: w.slice.id, offset: off, gain: ROLE_GAIN.lead - (k ? 2 : 0), velocity: k ? 0.6 : 0.85, fadeOut: 6, gesture: 'fragment' }));
        }
        return;
      }
      out.push(note({ tick: at, length: Math.min(nat, next - at), sliceId: w.slice.id, reverse: !!opts.reverseLast && i === seq.length - 1, gain: ROLE_GAIN.lead + (w === anchor ? 1 : 0), velocity: w === anchor ? 1 : 0.75, fadeOut: 20, gesture, motifId: w === anchor ? 'motif-anchor' : undefined }));
    });
  };
  let fragLevel = 0;
  for (const sec of form) {
    const start = sec.startBar * ctx.bar;
    for (let rep = 0; rep * spanTicks < sec.bars * ctx.bar; rep++) {
      const at = start + rep * spanTicks;
      let seq: (Material | null)[] = words.slice();
      let desc = '';
      switch (sec.op) {
        case 'state':
        case 'return':
          desc = sec.index === 0 ? 'original phrase' : 'original phrase returns';
          place(seq, at, 'original');
          break;
        case 'vary': {
          // reorder while preserving the beginning
          const head = seq.slice(0, 1);
          const rest = rng.shuffle(seq.slice(1));
          seq = [...head, ...rest];
          desc = 'words reordered, beginning preserved';
          place(seq, at, 'reorder');
          break;
        }
        case 'contrast':
        case 'displace': {
          // repeat the anchor word: "light light light tonight"
          const n = clamp(Math.round(2 + ctx.c.repetition * 2), 2, 4);
          seq = words.map((w, i) => (i >= anchorIdx && i < anchorIdx + n ? anchor : w));
          desc = `anchor word repeated ×${n}`;
          place(seq, at, 'repeat');
          break;
        }
        case 'break':
        case 'simplify': {
          // remove words, leaving deliberate gaps before the anchor
          seq = words.map((w, i) => (w === anchor || i === 0 ? w : rng.chance(0.55 + ctx.c.space * 0.3) ? null : w));
          desc = 'words removed – gaps before the anchor';
          place(seq, at, 'drop');
          break;
        }
        case 'fragment':
        case 'build': {
          fragLevel = Math.min(1, fragLevel + 0.35 + ctx.c.fragmentation * 0.3);
          desc = `phrase breaking apart (fragmentation ${(fragLevel * 100).toFixed(0)}%)`;
          place(seq, at, 'fragment', { frag: fragLevel, reverseLast: rng.chance(ctx.prof.reverse + 0.2) });
          break;
        }
      }
      if (rep === 0) ctx.log.push(`${sec.label}: ${desc}`);
    }
    if (sec.final && sec.op !== 'return') {
      // change the ending: finish on the anchor
      const endT = start + sec.bars * ctx.bar - ctx.beat;
      out.push(note({ tick: endT, length: Math.min(naturalTicks(ctx, anchor), ctx.beat), sliceId: anchor.slice.id, gain: ROLE_GAIN.lead, velocity: 0.9, gesture: 'ending', motifId: 'motif-anchor' }));
    }
  }
  // remove overlaps within the lead (later onset cuts earlier note)
  out.sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < out.length - 1; i++) if (out[i].tick + out[i].length > out[i + 1].tick) out[i].length = Math.max(1, out[i + 1].tick - out[i].tick);
  return { notes: out.filter((n, i) => i === 0 || n.tick !== out[i - 1].tick), anchor, words };
}

/* ------------------------------------------------------------------------ */
/* Microchop / stutter                                                       */
/* ------------------------------------------------------------------------ */

type ChopCell = 'single' | 'stutter2' | 'stutter3' | 'stutter4' | 'accel' | 'reverse-blip' | 'scrub' | 'gap';

export function writeMicroLead(ctx: Ctx, form: Section[], motif: Motif): Note[] {
  const rng = ctx.rng('micro');
  const vocabPool: ChopCell[] = ['single', 'stutter2', 'stutter3', 'stutter4', 'accel', 'reverse-blip', 'scrub', 'gap'];
  const w = [1, ctx.prof.stutter, ctx.prof.stutter * 0.8, ctx.prof.stutter * 0.6, ctx.prof.stutter * 0.5, ctx.prof.reverse * 1.5, ctx.c.fragmentation * 0.6, ctx.prof.gaps * 0.5];
  const vocab: ChopCell[] = ['single'];
  while (vocab.length < 3) {
    const c = rng.weighted(vocabPool, w);
    if (!vocab.includes(c)) vocab.push(c);
  }
  ctx.log.push(`Microchop vocabulary: ${vocab.join(', ')} – reused throughout for identity`);
  const out: Note[] = [];
  const longest = ctx.mats.slice().sort((a, b) => b.dur - a.dur)[0];
  for (const sec of form) {
    const start = sec.startBar * ctx.bar;
    const end = start + sec.bars * ctx.bar;
    // subdivision changes give each section its own rhythmic colour
    let sub = ctx.step / 2;
    if (sec.op === 'displace' || sec.op === 'contrast') sub = 160; // sixteenth-triplet grid
    if (sec.op === 'state' || sec.op === 'return') sub = ctx.step / 2;
    if (sec.op === 'build') sub = ctx.step / 4;
    let m = motif;
    if (sec.op === 'vary') m = develop(ctx, rng, motif, rng.pick(['shift-one', 'replace-one', 'reverse-some'] as DevOp[]), motif.protection);
    if (sec.op === 'displace') m = develop(ctx, rng, motif, 'displace', motif.protection);
    const desc: Record<string, string> = {
      state: 'base chop pattern (1/32 stutters)',
      vary: 'one chop cell changes',
      displace: 'pattern displaced onto a triplet stutter grid',
      contrast: 'triplet stutter grid',
      build: 'repetitions shorten toward the end',
      break: 'alternating sound and silence',
      fragment: `scrubbing through ${describeMaterial(longest)}`,
      return: 'base pattern returns',
      simplify: 'reduced to accents',
    };
    ctx.log.push(`${sec.label}: ${desc[sec.op] ?? sec.op}`);
    for (let at = start; at < end; at += m.span) {
      const barIdx = Math.round((at - start) / m.span);
      m.notes.forEach((n, i) => {
        const t = at + n.tick;
        if (t >= end) return;
        const next = i + 1 < m.notes.length ? at + m.notes[i + 1].tick : at + m.span;
        const room = Math.min(next, end) - t;
        let cell = vocab[(i * 2 + (n.accent > 0.5 ? 0 : 1)) % vocab.length];
        if (sec.op === 'break') cell = barIdx % 2 === i % 2 ? 'single' : 'gap';
        if (sec.op === 'simplify' && n.accent < 0.5) cell = 'gap';
        if (sec.op === 'fragment') cell = 'scrub';
        if (i === 0 && cell === 'gap') cell = 'single';
        const base = { sliceId: n.sliceId, semitones: n.semitones, offset: n.offset, gain: ROLE_GAIN.lead + (n.accent > 0.5 ? 0 : -2), velocity: n.accent > 0.5 ? 0.95 : 0.65, fadeIn: 1, fadeOut: 3, motifId: m.id === motif.id ? motif.id : undefined };
        const progress = (t - start) / Math.max(1, end - start);
        switch (cell) {
          case 'single':
            out.push(note({ ...base, tick: t, length: Math.min(room, Math.max(sub, n.length)), gesture: 'chop' }));
            break;
          case 'stutter2':
          case 'stutter3':
          case 'stutter4': {
            const k = Number(cell.slice(-1));
            for (let j = 0; j < k && j * sub < room; j++) out.push(note({ ...base, tick: t + j * sub, length: Math.max(20, Math.round(sub * 0.7)), gain: base.gain - j * 1.5, gesture: 'stutter' }));
            break;
          }
          case 'accel': {
            let gap = Math.min(room / 2, ctx.step);
            let tt = t;
            for (let j = 0; j < 6 && tt < t + room; j++) {
              out.push(note({ ...base, tick: Math.round(tt), length: Math.max(15, Math.round(gap * 0.7)), gesture: 'accel' }));
              tt += gap;
              gap = Math.max(30, gap * (sec.op === 'build' ? 0.6 - progress * 0.1 : 0.7));
            }
            break;
          }
          case 'reverse-blip':
            out.push(note({ ...base, tick: t, length: Math.min(room, ctx.step), reverse: true, gesture: 'reverse' }));
            break;
          case 'scrub': {
            const mat = sec.op === 'fragment' ? longest : ctx.matById.get(n.sliceId);
            if (!mat) break;
            const frames = mat.slice.end - mat.slice.start;
            const steps = Math.max(1, Math.floor(room / sub));
            for (let j = 0; j < steps; j++) {
              const pos = ((barIdx * steps + j) % 8) / 8;
              out.push(note({ ...base, sliceId: mat.slice.id, semitones: 0, tick: t + j * sub, length: Math.round(sub * 0.85), offset: Math.round(frames * pos), gesture: 'scrub' }));
            }
            break;
          }
          case 'gap':
            break;
        }
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* MIDI-guided                                                               */
/* ------------------------------------------------------------------------ */

export function writeMidiLead(ctx: Ctx, guide: MidiGuide): Note[] {
  const rng = ctx.rng('midi');
  const out: Note[] = [];
  const total = ctx.bars * ctx.bar;
  const notes = guide.notes.filter((n) => n.tick < total).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  if (!notes.length) throw new Error('The MIDI guide has no notes inside the arrangement length.');
  const hookPool = ctx.cast.hook.length ? ctx.cast.hook : ctx.mats;
  // rhythm-cycle: a stable motif-like assignment (A A B A …) instead of random choice
  const cyclePool = [...hookPool, ...ctx.cast.support].slice(0, 3);
  const pattern = ctx.c.repetition > 0.6 ? [0, 0, 1, 0] : [0, 1, 0, 2];
  const pitchesSorted = Array.from(new Set(notes.map((n) => n.pitch))).sort((a, b) => a - b);
  ctx.log.push(`MIDI guide “${guide.name}”: ${notes.length} notes, mapping = ${guide.mapping}${guide.usePitch ? ', pitch via playback rate' : ', timing only'}`);
  notes.forEach((n, i) => {
    let mat: Material | undefined;
    if (guide.mapping === 'single') mat = ctx.matById.get(ctx.s.sliceIds[0]) ?? hookPool[0];
    else if (guide.mapping === 'pitch-map') {
      const mapped = guide.pitchMap[n.pitch];
      mat = mapped ? ctx.matById.get(mapped) : undefined;
      if (!mat) mat = ctx.mats[pitchesSorted.indexOf(n.pitch) % ctx.mats.length];
    } else {
      // bar-relative position keeps the cycle aligned to the music
      const barPos = notes.filter((m) => Math.floor(m.tick / ctx.bar) === Math.floor(n.tick / ctx.bar) && m.tick < n.tick).length;
      mat = cyclePool[pattern[barPos % pattern.length] % cyclePool.length];
    }
    if (!mat) return;
    let semis = 0;
    if (guide.usePitch) {
      const ref = guide.mapping === 'pitch-map' ? n.pitch : guide.rootPitch;
      semis = guide.mapping === 'pitch-map' ? 0 : clamp(n.pitch - ref, -24, 24);
      if (ctx.song && guide.mapping !== 'pitch-map' && mat.pitch !== null) {
        // with a beat context, sing the MIDI note's pitch class from the slice's own pitch (nearest octave)
        let d = n.pitch - mat.pitch;
        while (d > 6) d -= 12;
        while (d < -6) d += 12;
        semis = Math.round(d * 100) / 100;
      }
    }
    const nat = naturalTicks(ctx, mat, semis);
    const length = guide.useDuration ? Math.min(n.length, nat) : nat;
    const vel = guide.useVelocity ? n.velocity : 0.8;
    out.push(note({ tick: n.tick, length: Math.max(1, length), sliceId: mat.slice.id, semitones: semis, velocity: vel, gain: ROLE_GAIN.lead + (guide.useVelocity ? 20 * Math.log10(Math.max(0.05, vel) / 0.8) : 0), fadeOut: 12, gesture: 'midi' }));
    void i;
  });
  void rng;
  // monophonic cut: a new trigger ends the previous one on the same track
  out.sort((a, b) => a.tick - b.tick);
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].tick > out[i].tick && out[i].tick + out[i].length > out[i + 1].tick) out[i].length = out[i + 1].tick - out[i].tick;
  return out;
}

/* ------------------------------------------------------------------------ */
/* Vocal Conversation                                                        */
/* ------------------------------------------------------------------------ */

export interface ConversationResult {
  a: Note[];
  b: Note[];
  under: Note[];
}

export function writeConversation(ctx: Ctx, form: Section[], matsA: Material[], matsB: Material[], relation: ConversationRelation): ConversationResult {
  const rng = ctx.rng(`conv:${relation}`);
  if (!matsA.length || !matsB.length) throw new Error('Vocal Conversation needs slices from two voices.');
  const castA = castMaterial(ctx.rng('castA'), matsA, ctx.c);
  const castB = castMaterial(ctx.rng('castB'), matsB, ctx.c);
  const kind = ctx.prof.sustain > 0.6 ? 'ghost' : ctx.prof.density > 0.5 ? 'rhythmic' : 'melodic';
  const save = ctx.cast;
  ctx.cast = castA;
  const motifA = createMotif(ctx, kind === 'ghost' ? 'ghost' : kind, 'motif-a', castA.hook.concat(castA.support));
  ctx.cast = castB;
  const motifB = createMotif(ctx, kind === 'ghost' ? 'ghost' : kind, 'motif-b', castB.hook.concat(castB.support));
  ctx.cast = save;
  const a: Note[] = [];
  const b: Note[] = [];
  const under: Note[] = [];
  const half = (sec: Section) => Math.max(ctx.bar / 2, Math.floor(sec.bars / 2) * ctx.bar || ctx.bar / 2);
  const fill = (target: Note[], m: Motif, from: number, to: number, extra: Partial<Note> = {}) => {
    for (let t = from; t < to; t += m.span) target.push(...clipNotes(motifToNotes(m, t, extra), from, to));
  };
  const relabel: Record<ConversationRelation, string> = {
    'call-response': 'A calls, B answers in the space left',
    alternating: 'voices alternate bar by bar, each developing its own motif',
    interrupt: 'A sings longer lines, B cuts in and interrupts',
    imitate: 'B imitates A’s rhythm one bar later',
    'overlap-growth': 'B’s entrances move earlier until the voices overlap',
    complementary: 'B fills only the rests of A (hocket)',
    ostinato: 'B repeats a fragment underneath A’s phrase',
    fragmenting: 'the conversation becomes increasingly fragmented',
  };
  ctx.log.push(`Conversation: ${relabel[relation]}`);
  ctx.log.push(`Voice A motif on ${describeMaterial(castA.hook[0])}, voice B on ${describeMaterial(castB.hook[0])}`);
  // development must stay inside each voice's own material
  const withCast = <T,>(cast: typeof castA, fn: () => T): T => {
    const prev = ctx.cast;
    ctx.cast = cast;
    try {
      return fn();
    } finally {
      ctx.cast = prev;
    }
  };
  form.forEach((sec, si) => {
    const start = sec.startBar * ctx.bar;
    const end = start + sec.bars * ctx.bar;
    const mA = withCast(castA, () => (sec.op === 'vary' ? develop(ctx, rng, motifA, 'vary-ending') : sec.op === 'fragment' ? develop(ctx, rng, motifA, 'fragment') : motifA));
    const mB = withCast(castB, () => (sec.op === 'vary' ? develop(ctx, rng, motifB, 'shift-one') : motifB));
    switch (relation) {
      case 'call-response': {
        const h = start + half(sec);
        fill(a, mA, start, h, { gesture: 'call' });
        ctx.cast = castB;
        const ans = answerMotif(ctx, rng, mA, castB.hook.concat(castB.support), 'motif-b-answer', 'imitate');
        ctx.cast = save;
        fill(b, ans, h, end, { gesture: 'answer' });
        break;
      }
      case 'alternating':
        for (let bar = sec.startBar; bar < sec.startBar + sec.bars; bar++) {
          const s = bar * ctx.bar;
          if (bar % 2 === 0) fill(a, mA, s, s + ctx.bar, { gesture: 'call' });
          else fill(b, mB, s, s + ctx.bar, { gesture: 'answer' });
        }
        break;
      case 'interrupt': {
        fill(a, mA, start, end, { gesture: 'line' });
        const at = start + Math.round((sec.bars * ctx.bar * rng.pick([0.375, 0.5, 0.625])) / ctx.step) * ctx.step;
        const len = ctx.beat * rng.int(1, 2);
        const bm = castB.accent[0] ?? castB.hook[0];
        for (let t = at; t < at + len; t += ctx.step * 2) b.push(note({ tick: t, length: Math.min(ctx.step * 2, naturalTicks(ctx, bm)), sliceId: bm.slice.id, velocity: 0.95, gain: 0, gesture: 'interrupt' }));
        // the interruption truncates voice A
        for (const n of a) if (n.tick < at + len && n.tick + n.length > at) n.length = Math.max(1, at - n.tick);
        for (let i = a.length - 1; i >= 0; i--) if (a[i].tick >= at && a[i].tick < at + len) a.splice(i, 1);
        break;
      }
      case 'imitate': {
        fill(a, mA, start, end, { gesture: 'call' });
        // B copies the rhythm of A one bar later with its own slices
        const delay = ctx.bar;
        const pool = castB.hook.concat(castB.support);
        a.filter((n) => n.tick >= start && n.tick < end).forEach((n, i) => {
          const t = n.tick + delay;
          if (t >= ctx.bars * ctx.bar) return;
          const m = pool[i % pool.length];
          b.push(note({ ...n, tick: t, sliceId: m.slice.id, semitones: semisFor(ctx, m, 0), offset: 0, motifId: undefined, gesture: 'imitation', length: Math.min(n.length, naturalTicks(ctx, m)) }));
        });
        break;
      }
      case 'overlap-growth': {
        const h = start + half(sec);
        const shift = Math.round(((si / Math.max(1, form.length - 1)) * half(sec)) / ctx.beat) * ctx.beat;
        fill(a, mA, start, h + shift, { gesture: 'call' });
        fill(b, mB, Math.max(start, h - shift), end, { gesture: shift ? 'overlap' : 'answer' });
        if (si === form.length - 1) ctx.log.push(`${sec.label}: voices overlap by ${shift / ctx.beat} beat(s)`);
        break;
      }
      case 'complementary': {
        fill(a, mA, start, end, { gesture: 'call' });
        const occupied = (t: number) => a.some((n) => t >= n.tick && t < n.tick + Math.max(ctx.step, n.length));
        const pool = castB.perc.concat(castB.hook);
        let k = 0;
        for (let t = start; t < end; t += ctx.step * 2) {
          if (occupied(t)) continue;
          const m = pool[k++ % pool.length];
          b.push(note({ tick: t, length: Math.min(ctx.step * 2, naturalTicks(ctx, m)), sliceId: m.slice.id, velocity: 0.7, gesture: 'hocket' }));
        }
        break;
      }
      case 'ostinato': {
        fill(a, mA, start, end, { gesture: 'phrase' });
        const frag = castB.perc[0] ?? castB.hook[0];
        const pattern = [0, 3, 6, 10, 12];
        for (let bar = sec.startBar; bar < sec.startBar + sec.bars; bar++)
          for (const st of pattern) under.push(note({ tick: bar * ctx.bar + st * ctx.step, length: Math.min(ctx.step * 2, naturalTicks(ctx, frag)), sliceId: frag.slice.id, velocity: 0.6, gain: -4, gesture: 'ostinato' }));
        break;
      }
      case 'fragmenting': {
        const level = si / Math.max(1, form.length - 1);
        const chunk = Math.max(ctx.step * 2, Math.round((ctx.bar * (1 - level * 0.8)) / ctx.step) * ctx.step);
        let turn = 0;
        for (let t = start; t < end; t += chunk, turn++) {
          const target = turn % 2 ? b : a;
          const m = turn % 2 ? mB : mA;
          const ns = clipNotes(motifToNotes(level > 0.5 ? withCast(turn % 2 ? castB : castA, () => develop(ctx, rng, m, 'shorten')) : m, t, { gesture: 'fragment' }), t, Math.min(end, t + chunk));
          target.push(...ns);
        }
        if (si === form.length - 1) ctx.log.push(`${sec.label}: turns shrink to ${chunk / ctx.step} sixteenths`);
        break;
      }
    }
  });
  const fin = (ns: Note[], pan: number, gain: number) => ns.map((n) => ({ ...n, pan: n.pan || pan, gain: n.gain + gain, fadeIn: Math.max(n.fadeIn, ctx.prof.fadeIn), fadeOut: Math.max(n.fadeOut, ctx.prof.fadeOut) }));
  return { a: fin(a, -0.35, ROLE_GAIN.lead), b: fin(b, 0.35, ROLE_GAIN.response + 1), under: fin(under, 0, ROLE_GAIN.rhythm) };
}
