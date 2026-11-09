import type { ScaleName } from '../types';

export const SCALES: Record<ScaleName, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  'major-pentatonic': [0, 2, 4, 7, 9],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

/** Semitone offset of a (possibly negative) scale degree. */
export function degreeToSemis(scale: number[], degree: number): number {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return scale[idx] + 12 * oct;
}

/** Nearest MIDI pitch belonging to the scale rooted at keyRoot. */
export function quantizeToScale(midi: number, keyRoot: number, scale: number[]): number {
  let best = Math.round(midi);
  let bestD = Infinity;
  for (let m = Math.floor(midi) - 7; m <= Math.ceil(midi) + 7; m++) {
    const pc = (((m - keyRoot) % 12) + 12) % 12;
    if (!scale.includes(pc)) continue;
    const d = Math.abs(m - midi);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/**
 * Transposition (semitones) that moves a slice with natural pitch `natural` to the
 * target scale tone `targetMidi`, folded into the nearest octave so that the
 * playback-rate change (which also changes duration) stays small.
 */
export function transposeToTarget(natural: number, targetMidi: number, maxShift = 7): number {
  let d = targetMidi - natural;
  while (d > maxShift) d -= 12;
  while (d < -maxShift) d += 12;
  return Math.round(d * 100) / 100;
}

export type Contour = 'arch' | 'descend' | 'ascend' | 'pendulum' | 'static' | 'leap' | 'valley';
export const CONTOURS: Record<Contour, number[]> = {
  arch: [0, 2, 4, 2, 1],
  descend: [4, 3, 2, 1, 0],
  ascend: [0, 1, 2, 4, 4],
  pendulum: [0, 3, 0, 4, 1],
  static: [0, 0, 0, 0, 2],
  leap: [0, 0, 5, 4, 2],
  valley: [2, 0, -1, 0, 2],
};

/** Sample a contour shape at position t (0..1) and scale by movement amount. */
export function contourAt(c: Contour, t: number, movement: number): number {
  const pts = CONTOURS[c];
  const x = Math.min(0.9999, Math.max(0, t)) * (pts.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const v = pts[i] * (1 - f) + pts[Math.min(pts.length - 1, i + 1)] * f;
  return Math.round(v * movement);
}
