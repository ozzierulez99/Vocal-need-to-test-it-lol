import type { Motif } from '../types';
import { PPQ } from '../types';
import type { Ctx, Note } from './context';
import { note, naturalTicks } from './context';
import type { Section } from './form';
import { hashString } from '../rng';

/**
 * Ornaments: the production devices that make a chop line feel finished –
 * pitch scoops, tape-stop falls, octave jumps, octave doubles, arranged echo
 * throws and trance-gated long notes. All of them are ordinary events, so they
 * stay editable and export dry.
 *
 * Decisions are keyed to a note's position inside its phrase, so a restated
 * phrase receives the same ornaments (a return really is a return).
 */
export interface OrnamentResult {
  lead: Note[];
  /** extra events for the "Echoes & doubles" layer */
  extra: Note[];
  log: string[];
}

const GATES = ['x.xx.xx.', 'xx.xx.x.', 'x.x.xxx.', 'xxx.xx.x'];

export function ornament(ctx: Ctx, form: Section[], lead: Note[], motif: Motif | null): OrnamentResult {
  const tr = ctx.prof.traits;
  const phrase = ctx.phraseBars * ctx.bar;
  const preserved = !!motif && motif.important && motif.protection === 'preserve';
  const roll = (key: string, n: Note) => (hashString(`${ctx.s.seed}|orn|${key}|${n.tick % phrase}|${n.sliceId}`) >>> 0) / 4294967296;
  const sectionAt = (tick: number) => form.find((s) => tick >= s.startBar * ctx.bar && tick < (s.startBar + s.bars) * ctx.bar);
  const purpose = ctx.s.purpose ?? 'hook';
  const pitched = (n: Note) => ctx.matById.get(n.sliceId)?.pitch != null;
  const playTicks = (n: Note) => Math.min(n.length, naturalTicks(ctx, ctx.matById.get(n.sliceId), n.semitones));
  const total = ctx.bars * ctx.bar;
  const out: Note[] = lead.map((n) => ({ ...n }));
  const extra: Note[] = [];
  const counts = { scoop: 0, fall: 0, jump: 0, stack: 0, echo: 0, gate: 0 };
  out.sort((a, b) => a.tick - b.tick);

  // 1 · scoops into accented or long notes
  if (ctx.s.transpose)
    for (const n of out) {
      if (!pitched(n) || n.reverse || n.gesture === 'gate') continue;
      if ((n.velocity >= 0.85 || playTicks(n) >= ctx.beat) && roll('scoop', n) < tr.glide) {
        n.glideIn = [roll('scoopd', n) < 0.6 ? -2 : -1, 35 + Math.round(roll('scoopt', n) * 40)];
        counts.scoop++;
      }
    }

  // 2 · octave jump at the end of a run of repeated notes (never inside a stated motif)
  for (let i = 2; i < out.length; i++) {
    const [a, b, c] = [out[i - 2], out[i - 1], out[i]];
    const same = a.sliceId === c.sliceId && b.sliceId === c.sliceId && Math.abs(a.semitones - c.semitones) < 0.01 && Math.abs(b.semitones - c.semitones) < 0.01;
    const close = c.tick - b.tick <= ctx.beat && b.tick - a.tick <= ctx.beat;
    if (same && close && !c.gesture?.startsWith('motif') && pitched(c) && c.semitones + 12 <= 14 && roll('jump', c) < tr.octaveJump) {
      c.semitones += 12;
      counts.jump++;
    }
  }

  // 3 · phrase-end tape-stop and echo throws
  for (const sec of form) {
    const s0 = sec.startBar * ctx.bar;
    const s1 = s0 + sec.bars * ctx.bar;
    const inSec = out.filter((n) => n.tick >= s0 && n.tick < s1);
    if (!inSec.length) continue;
    const last = inSec[inSec.length - 1];
    const gapAfter = s1 - (last.tick + playTicks(last));
    if (ctx.s.transpose && pitched(last) && playTicks(last) >= ctx.beat * 0.75 && !(preserved && last.gesture === 'motif') && roll('fall', last) < tr.tapeStop) {
      const ms = Math.min(320, ((playTicks(last) * 60000) / (ctx.bpm * PPQ)) * 0.6);
      last.glideOut = [-12, Math.round(ms)];
      counts.fall++;
    }
    // echo throws: any note followed by a real gap can be thrown into it
    for (let i = 0; i < inSec.length; i++) {
      const n = inSec[i];
      const next = inSec[i + 1]?.tick ?? s1;
      const gap = next - (n.tick + Math.min(playTicks(n), ctx.beat));
      if (gap < ctx.beat * 1.5 || roll('echo', n) >= tr.echo) continue;
      const interval = gap >= ctx.beat * 3 ? (PPQ * 3) / 4 : PPQ / 2; // dotted eighth, or eighth in tight gaps
      const len = Math.min(playTicks(n), Math.round(interval * 0.9));
      for (let k = 1; k <= 3; k++) {
        const t = n.tick + k * interval;
        if (t + len > next - ctx.step || t >= total) break;
        extra.push(note({ tick: t, length: len, sliceId: n.sliceId, semitones: n.semitones, offset: n.offset, gain: n.gain - 5.5 * k, velocity: Math.max(0.2, n.velocity - 0.2 * k), pan: (k % 2 ? 1 : -1) * 0.35, fadeIn: 3, fadeOut: Math.max(20, n.fadeOut), gesture: 'echo' }));
        counts.echo++;
      }
    }
    void gapAfter;
  }

  // 4 · octave doubles on the big moments
  const stackUp = ctx.lift >= 10 ? -12 : 12;
  for (const n of out) {
    const sec = sectionAt(n.tick);
    if (!sec || !pitched(n) || n.velocity < 0.85) continue;
    const big = purpose === 'drop' || sec.energy >= 0.7 || (sec.final && sec.op === 'return');
    if (big && roll('stack', n) < tr.stack && Math.abs(n.semitones + stackUp) <= 16) {
      extra.push(note({ tick: n.tick, length: n.length, sliceId: n.sliceId, semitones: n.semitones + stackUp, offset: n.offset, gain: n.gain - 8, velocity: n.velocity * 0.8, pan: roll('stackp', n) < 0.5 ? -0.25 : 0.25, fadeIn: n.fadeIn, fadeOut: n.fadeOut, gesture: 'double', glideIn: n.glideIn }));
      counts.stack++;
    }
  }

  // 5 · trance-gate: a long held note becomes a rhythm while the vowel keeps moving
  const gated: Note[] = [];
  for (const n of out) {
    const play = playTicks(n);
    const mat = ctx.matById.get(n.sliceId);
    if (!mat || n.gesture === 'motif' || n.reverse || play < ctx.beat * 1.5 || roll('gate', n) >= tr.gate) {
      gated.push(n);
      continue;
    }
    const pat = GATES[Math.floor(roll('gatep', n) * GATES.length) % GATES.length];
    const rate = Math.pow(2, n.semitones / 12);
    const framesPerTick = (60 / (ctx.bpm * PPQ)) * mat.source.sampleRate * rate;
    const startStep = Math.round(n.tick / ctx.step);
    for (let k = 0; k * ctx.step < play; k++) {
      if (pat[(startStep + k) % pat.length] !== 'x') continue;
      const dt = k * ctx.step;
      gated.push({ ...n, tick: n.tick + dt, length: Math.round(ctx.step * 0.8), offset: n.offset + Math.round(dt * framesPerTick), align: k === 0 ? n.align : false, glideIn: k === 0 ? n.glideIn : undefined, glideOut: undefined, fadeIn: 2, fadeOut: 6, gesture: 'gate', velocity: k % 4 === 0 ? n.velocity : n.velocity * 0.85 });
    }
    counts.gate++;
  }

  const log: string[] = [];
  const bits = [
    counts.scoop && `${counts.scoop} pitch scoops`,
    counts.fall && `${counts.fall} tape-stop falls`,
    counts.jump && `${counts.jump} octave jumps`,
    counts.stack && `${counts.stack} octave doubles`,
    counts.echo && `${counts.echo} echo throws`,
    counts.gate && `${counts.gate} gated notes`,
  ].filter(Boolean);
  if (bits.length) log.push(`Ornaments: ${bits.join(', ')}`);
  return { lead: gated.sort((a, b) => a.tick - b.tick), extra, log };
}
