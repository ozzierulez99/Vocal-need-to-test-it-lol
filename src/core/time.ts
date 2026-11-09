import { PPQ } from './types';

export function ticksPerBeat(timeSig: [number, number]): number {
  return (PPQ * 4) / timeSig[1];
}
export function ticksPerBar(timeSig: [number, number]): number {
  return ticksPerBeat(timeSig) * timeSig[0];
}
export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks * 60) / (bpm * PPQ);
}
export function secondsToTicks(sec: number, bpm: number): number {
  return (sec * bpm * PPQ) / 60;
}
/** Absolute (non-accumulating) tick → frame conversion. */
export function ticksToFrames(ticks: number, bpm: number, sampleRate: number): number {
  return Math.round((ticks * 60 * sampleRate) / (bpm * PPQ));
}
export function snapTick(tick: number, grid: number): number {
  return Math.round(tick / grid) * grid;
}
export function formatBarBeat(tick: number, timeSig: [number, number]): string {
  const bar = Math.floor(tick / ticksPerBar(timeSig));
  const inBar = tick - bar * ticksPerBar(timeSig);
  const beat = Math.floor(inBar / ticksPerBeat(timeSig));
  const sub = Math.floor((inBar - beat * ticksPerBeat(timeSig)) / (PPQ / 4));
  return `${bar + 1}.${beat + 1}.${sub + 1}`;
}
export const semitonesToRate = (st: number) => Math.pow(2, st / 12);
export const rateToSemitones = (r: number) => 12 * Math.log2(r);
export const dbToGain = (db: number) => (db <= -96 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0 ? -96 : 20 * Math.log10(g));
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiToName(m: number): string {
  const r = Math.round(m);
  return `${NOTE_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}
export function nameToMidi(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + acc;
}
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}
