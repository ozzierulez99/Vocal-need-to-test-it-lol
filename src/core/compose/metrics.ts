import type { CandidateMetrics, SeqEvent, Slice, SourceAudio } from '../types';
import { PPQ } from '../types';
import { slicePitch } from '../slicing/slices';
import { syncopationOf } from './rhythm';
import { ticksPerBar, semitonesToRate } from '../time';

/** Musical descriptors of a sequence used to label and diversify candidates. */
export function computeMetrics(
  events: SeqEvent[],
  slices: Slice[],
  sources: SourceAudio[],
  bpm: number,
  timeSig: [number, number],
  bars: number,
): CandidateMetrics & { surprise: number } {
  const sliceMap = new Map(slices.map((s) => [s.id, s]));
  const srcMap = new Map(sources.map((s) => [s.id, s]));
  const step = PPQ / 4;
  const bar = ticksPerBar(timeSig);
  const totalSteps = Math.max(1, Math.round((bars * bar) / step));
  if (!events.length)
    return { density: 0, repetition: 0, pitchSpread: 0, fragmentation: 0, syncopation: 0, silence: 1, variety: 0, surprise: 0 };
  const sounding = new Uint8Array(totalSteps);
  const pitches: number[] = [];
  let frag = 0;
  let reverse = 0;
  let offs = 0;
  for (const e of events) {
    const sl = sliceMap.get(e.sliceId);
    const src = sl ? srcMap.get(sl.sourceId) : undefined;
    const sliceSec = sl && src ? (sl.end - sl.start - e.offset) / src.sampleRate / semitonesToRate(e.semitones) : 0.2;
    const gateSec = (e.length * 60) / (bpm * PPQ);
    const play = Math.min(sliceSec, gateSec);
    const playTicks = (play * bpm * PPQ) / 60;
    for (let s = Math.floor(e.tick / step); s < Math.min(totalSteps, Math.ceil((e.tick + playTicks) / step)); s++) sounding[s] = 1;
    const p = sl ? slicePitch(sl, src) : null;
    pitches.push((p ?? 60) + e.semitones);
    frag += (play < 0.12 ? 0.5 : 0) + (e.offset > 0 ? 0.25 : 0) + (sliceSec > 0 ? (1 - Math.min(1, play / sliceSec)) * 0.25 : 0);
    if (e.reverse) reverse++;
    if (e.offset > 0) offs++;
  }
  const silence = 1 - sounding.reduce((a, b) => a + b, 0) / totalSteps;
  const beats = (bars * bar) / (PPQ * (4 / timeSig[1]));
  const onsetSteps = Array.from(new Set(events.map((e) => Math.round(e.tick / step))));
  const density = Math.min(1, onsetSteps.length / beats / 4);
  const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
  const sd = Math.sqrt(pitches.reduce((a, b) => a + (b - mean) ** 2, 0) / pitches.length);
  // melodic motion: average absolute interval between consecutive onsets
  const ordered = events.slice().sort((a, b) => a.tick - b.tick);
  let motion = 0;
  for (let i = 1; i < ordered.length; i++) {
    const a = (slicePitch(sliceMap.get(ordered[i - 1].sliceId)!, undefined) ?? 60) + ordered[i - 1].semitones;
    const b = (slicePitch(sliceMap.get(ordered[i].sliceId)!, undefined) ?? 60) + ordered[i].semitones;
    motion += Math.min(7, Math.abs(b - a));
  }
  motion /= Math.max(1, ordered.length - 1);
  // bar-signature repetition
  const sigs: Set<string>[] = [];
  for (let b = 0; b < bars; b++) {
    sigs.push(new Set(events.filter((e) => Math.floor(e.tick / bar) === b).map((e) => `${Math.round((e.tick - b * bar) / step)}:${e.sliceId}`)));
  }
  let rep = 0;
  let cnt = 0;
  for (let b = 1; b < bars; b++) {
    if (!sigs[b].size) continue;
    let best = 0;
    for (let p = 0; p < b; p++) {
      if (!sigs[p].size) continue;
      let inter = 0;
      for (const x of sigs[b]) if (sigs[p].has(x)) inter++;
      best = Math.max(best, inter / (sigs[b].size + sigs[p].size - inter));
    }
    rep += best;
    cnt++;
  }
  const repetition = cnt ? rep / cnt : 0;
  const variety = new Set(events.map((e) => e.sliceId)).size / Math.min(events.length, 12);
  const surprise = Math.min(1, (reverse / events.length) * 2 + (1 - repetition) * 0.4 + (offs / events.length) * 0.3);
  return {
    density,
    repetition,
    pitchSpread: Math.min(1, (sd / 6) * 0.6 + (motion / 5) * 0.4),
    fragmentation: Math.min(1, frag / events.length),
    syncopation: syncopationOf(onsetSteps),
    silence,
    variety: Math.min(1, variety),
    surprise,
  };
}

/** Jaccard similarity of two event sets on a 16th grid (0 = unrelated, 1 = identical). */
export function similarity(a: SeqEvent[], b: SeqEvent[]): number {
  const sig = (es: SeqEvent[]) => new Set(es.map((e) => `${Math.round(e.tick / (PPQ / 4))}:${e.sliceId}:${Math.round(e.semitones)}`));
  const A = sig(a);
  const B = sig(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
