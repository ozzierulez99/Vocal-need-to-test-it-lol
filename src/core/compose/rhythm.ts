import type { RhythmFeel } from '../types';
import type { Rng } from '../rng';

/**
 * Rhythmic grammar. Patterns are written over 8 sixteenth steps (half a 4/4 bar):
 *   X = accented onset, x = onset, - = hold previous note, . = rest
 * A bar rhythm is two cells; phrases are built by repeating/varying cells so a
 * piece keeps a coherent rhythmic identity instead of independent random hits.
 */
export const CELLS: Record<RhythmFeel, string[]> = {
  tight: ['X.x.X.x.', 'X.x.x.x.', 'X...x.x.', 'X.xxX.x.', 'X-x-X-x-'],
  bouncy: ['X..x..x.', 'X..x.x..', 'x..X..x.', 'X.x..x..', 'X..x..X.'],
  syncopated: ['.x.X..x.', 'X..x.X..', '..X..x.x', 'x.X..X..', 'X..X..x.'],
  sparse: ['X.......', '....X...', 'X-----x.', '......X.', 'X---....'],
  energetic: ['XxxXxxXx', 'X.xxX.xx', 'XxX.xXx.', 'xXxxXxXx', 'X.X.XxXx'],
  broken: ['X..x.X..', 'x.X...xX', 'X.x..x..', '...X.x.X', 'X...xX..'],
  experimental: ['X....x..', 'x..X...x', '.X..x...', 'X.x....X', '..x..X.x'],
  hypnotic: ['X..x..x.', 'X...x..x', 'X..x..x.', 'X.x...x.', 'X..x..x.'],
};

export interface Hit {
  /** step index (sixteenths) from pattern start */
  step: number;
  /** length in steps (until next onset or explicit hold) */
  len: number;
  accent: boolean;
}

export function parseCell(cell: string, offsetSteps = 0): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i];
    if (c === 'X' || c === 'x') hits.push({ step: offsetSteps + i, len: 1, accent: c === 'X' });
    else if (c === '-' && hits.length) hits[hits.length - 1].len++;
  }
  return hits;
}

/** Bjorklund-style euclidean pattern as an X/x/. string. */
export function euclid(pulses: number, steps: number, rotate = 0): string {
  const p = Math.max(0, Math.min(steps, pulses));
  const out: string[] = [];
  for (let i = 0; i < steps; i++) out.push(Math.floor(((i + rotate) * p) / steps) !== Math.floor(((i + rotate + 1) * p) / steps) ? 'x' : '.');
  // accent first onset
  const first = out.indexOf('x');
  if (first >= 0) out[first] = 'X';
  return out.join('');
}

/** Choose two related cells forming a one-bar rhythmic identity. */
export function chooseBarCells(rng: Rng, feel: RhythmFeel, complexity: number, surprise: number): [string, string] {
  const pool = CELLS[feel];
  let a = rng.pick(pool);
  if (feel === 'experimental' || rng.chance(surprise * 0.35)) {
    a = euclid(rng.int(2, 5), 8, rng.int(0, 7));
  }
  // The second cell either repeats (identity), answers (different cell) or is a variant.
  const r = rng.next();
  let b: string;
  if (feel === 'hypnotic' || r < 0.3 - complexity * 0.15) b = a;
  else if (r < 0.7) b = rng.pick(pool.filter((c) => c !== a).concat(a));
  else b = mutateCell(rng, a, 1 + Math.round(complexity * 2));
  return [a, b];
}

/** Small structured mutation: move, add or remove one onset (never the first). */
export function mutateCell(rng: Rng, cell: string, changes = 1): string {
  const arr = cell.split('');
  for (let c = 0; c < changes; c++) {
    const i = rng.int(1, arr.length - 1);
    const op = rng.int(0, 2);
    if (op === 0 && arr[i] === '.') arr[i] = 'x';
    else if (op === 1 && (arr[i] === 'x' || arr[i] === 'X')) arr[i] = '.';
    else if (op === 2) {
      const j = Math.min(arr.length - 1, Math.max(1, i + (rng.chance(0.5) ? 1 : -1)));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  if (!arr.some((c) => c === 'x' || c === 'X')) arr[0] = 'X';
  return arr.join('');
}

/** Thin or thicken a pattern according to density (0..1). Keeps accents. */
export function applyDensity(rng: Rng, cell: string, density: number): string {
  return cell
    .split('')
    .map((c, i) => {
      if (c === 'x' && density < 0.5 && rng.chance((0.5 - density) * 1.4)) return '.';
      if (c === '.' && density > 0.6 && i % 2 === 0 && rng.chance((density - 0.6) * 1.2)) return 'x';
      return c;
    })
    .join('');
}

/** Swing: delay odd sixteenths by `amount` of a step (UKG-style shuffle). */
export function swingOffset(step: number, amount: number, stepTicks: number): number {
  return step % 2 === 1 ? Math.round(amount * stepTicks) : 0;
}

/** Fraction of onsets that fall on off-beat 8ths or 16ths. */
export function syncopationOf(steps: number[]): number {
  if (!steps.length) return 0;
  let s = 0;
  for (const st of steps) {
    const m = ((st % 4) + 4) % 4;
    if (m === 1 || m === 3) s += 1;
    else if (m === 2) s += 0.5;
  }
  return s / steps.length;
}
