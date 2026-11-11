import type { ComposeMode } from '../types';
import type { Ctx } from './context';

/**
 * Short musical forms. Each section is one phrase long and carries a
 * development intention for the lead plus an energy level read by the
 * supporting layers.
 */
export type SectionOp =
  | 'state'
  | 'vary'
  | 'contrast'
  | 'return'
  | 'build'
  | 'break'
  | 'fragment'
  | 'simplify'
  | 'displace';

export interface Section {
  index: number;
  startBar: number;
  bars: number;
  op: SectionOp;
  label: string;
  energy: number;
  final: boolean;
}

const TEMPLATES: Record<number, SectionOp[]> = {
  1: ['state'],
  2: ['state', 'vary'],
  3: ['state', 'vary', 'return'],
  4: ['state', 'vary', 'contrast', 'return'],
  5: ['state', 'vary', 'contrast', 'build', 'return'],
  6: ['state', 'vary', 'contrast', 'vary', 'build', 'return'],
  7: ['state', 'vary', 'contrast', 'return', 'break', 'build', 'return'],
  8: ['state', 'vary', 'contrast', 'return', 'break', 'fragment', 'build', 'return'],
};

export function planForm(ctx: Ctx, mode: ComposeMode): Section[] {
  const n = Math.max(1, Math.ceil(ctx.bars / ctx.phraseBars));
  const rng = ctx.rng('form');
  const { c, prof } = ctx;
  let ops: SectionOp[] = (TEMPLATES[Math.min(8, n)] ?? TEMPLATES[8]).slice();
  while (ops.length < n) ops.splice(ops.length - 1, 0, rng.pick(['vary', 'contrast', 'fragment', 'build'] as SectionOp[]));
  ops = ops.slice(0, n);
  // Directions and controls change real decisions about the form.
  for (let i = 1; i < ops.length - 1; i++) {
    if (ops[i] === 'contrast') {
      if (c.fragmentation > 0.65) ops[i] = 'fragment';
      else if (prof.gaps > 0.7 && rng.chance(0.6)) ops[i] = 'break';
    }
    if (ops[i] === 'vary' && rng.chance(c.surprise * 0.5)) ops[i] = rng.pick(['displace', 'fragment'] as SectionOp[]);
    if (ops[i] === 'build' && prof.build < 0.25) ops[i] = 'simplify';
  }
  if (mode === 'phrase') {
    // original → reordered → repeated word → words removed → breaking apart → … → original returns
    const cycle: SectionOp[] = ['vary', 'contrast', 'break', 'fragment', 'build'];
    const start = c.repetition > 0.8 ? 1 : 0; // very repetitive pieces go straight to the repeated word
    ops = ops.map((_, i) => (i === 0 ? 'state' : cycle[(i - 1 + start) % cycle.length]));
    if (n >= 3) ops[n - 1] = 'return';
    if (n >= 6 && c.repetition > 0.5) ops[Math.floor(n / 2)] = 'return'; // alternate original and reconstructed
  }
  if (mode === 'ghost') ops = ops.map((o, i) => (i === 0 ? 'state' : o === 'build' ? 'vary' : o === 'contrast' ? 'break' : o));
  if (mode === 'microchop') ops = ops.map((o, i) => (o === 'contrast' ? 'displace' : o === 'simplify' ? 'break' : o));
  if (c.repetition > 0.8) ops = ops.map((o, i) => (i > 0 && (o === 'contrast' || o === 'displace') && rng.chance(0.5) ? 'vary' : o));
  if (n >= 3 && ops[n - 1] !== 'return' && c.repetition > 0.4) ops[n - 1] = 'return';
  if (prof.build < 0.2 && n >= 3) ops[n - 1] = ops[n - 1] === 'return' ? 'return' : 'simplify';

  // Song-section purpose reshapes the form (phrase reconstruction keeps its own journey).
  const purpose = ctx.s.purpose ?? 'hook';
  let energyOf: ((i: number) => number) | null = null;
  if (mode !== 'phrase' && mode !== 'midi' && purpose !== 'hook') {
    const last = Math.max(1, n - 1);
    if (purpose === 'build') {
      ops = ops.map((_, i) => (i === 0 ? 'simplify' : i === n - 1 ? 'build' : i % 2 ? 'state' : 'vary'));
      energyOf = (i) => 0.3 + (0.7 * i) / last;
    } else if (purpose === 'drop') {
      ops = ops.map((_, i) => (i === 0 ? 'state' : i === n - 1 ? 'return' : i % 2 ? 'vary' : n > 3 && i === 2 ? 'contrast' : 'state'));
      energyOf = () => 0.9;
    } else if (purpose === 'intro') {
      ops = ops.map((_, i) => (i < n / 2 ? 'simplify' : i === n - 1 ? 'vary' : 'state'));
      energyOf = (i) => 0.25 + (0.4 * i) / last;
    } else if (purpose === 'outro') {
      ops = ops.map((_, i) => (i === 0 ? 'state' : i === n - 1 ? 'break' : 'simplify'));
      energyOf = (i) => 0.6 - (0.4 * i) / last;
    } else if (purpose === 'verse') {
      ops = ops.map((_, i) => (i === n - 1 && n > 2 ? 'return' : i % 2 ? 'vary' : 'state'));
      energyOf = () => 0.4;
    }
  }

  const labels: string[] = [];
  const seen = new Map<string, number>();
  const base: Record<SectionOp, string> = {
    state: 'A', vary: 'A', return: 'A', displace: 'A', simplify: 'A', contrast: 'B', break: 'C', build: 'B', fragment: 'B',
  };
  for (const o of ops) {
    const b = base[o];
    const k = seen.get(b) ?? 0;
    seen.set(b, k + 1);
    labels.push(b + "'".repeat(k));
  }
  return ops.map((op, i) => {
    const energy = energyOf ? energyOf(i) :
      op === 'break' ? 0.25 : op === 'build' ? 0.9 : op === 'simplify' ? 0.4 : op === 'contrast' ? 0.7 : op === 'fragment' ? 0.75 : 0.55 + (i / Math.max(1, n - 1)) * prof.build * 0.4;
    return {
      index: i,
      startBar: i * ctx.phraseBars,
      bars: Math.min(ctx.phraseBars, ctx.bars - i * ctx.phraseBars),
      op,
      label: labels[i],
      energy,
      final: i === n - 1,
    };
  });
}

export function describeForm(sections: Section[]): string {
  return sections.map((s) => `${s.label}(${s.op})`).join(' → ');
}
