import type { Candidate } from '../core/types';
import { ticksPerBar } from '../core/time';
import { engine } from './audio/engine';
import { useStore } from './store/store';

const st = () => useStore.getState();

const candSeqCache = new Map<string, { key: Candidate; bpm: number; seq: { events: Candidate['events']; tracks: Candidate['tracks']; bpm: number; groove?: Candidate['groove'] } }>();

function target() {
  const { doc, ui } = st();
  if (ui.auditioning) {
    const c = doc.candidates.find((x) => x.id === ui.auditioning);
    if (c) {
      const hit = candSeqCache.get(c.id);
      if (hit && hit.key === c && hit.bpm === doc.sequence.bpm) return hit.seq;
      const seq = { events: c.events, tracks: c.tracks, bpm: doc.sequence.bpm, groove: c.groove ?? doc.sequence.groove };
      candSeqCache.set(c.id, { key: c, bpm: doc.sequence.bpm, seq });
      return seq;
    }
  }
  return doc.sequence;
}

// stable object identity for the preview so the engine can cache the tiled notes
let previewKey: { src: unknown; gain: number; v: { notes: any[]; lengthTicks: number; gain: number } } | null = null;
function stablePreview(b: { notes: any[]; lengthTicks: number; gain: number }, src: unknown) {
  if (previewKey && previewKey.src === src && previewKey.gain === b.gain) return previewKey.v;
  previewKey = { src, gain: b.gain, v: b };
  return b;
}

export function play(fromTick?: number) {
  const { doc } = st();
  for (const [id, a] of st().rt.audio) engine.setAudio(id, a);
  const seq = doc.sequence;
  const end = seq.bars * ticksPerBar(seq.timeSig);
  const loop = seq.loop.enabled ? { startTick: seq.loop.startTick, endTick: Math.min(end, seq.loop.endTick) } : null;
  engine.play({
    seq: target,
    slices: () => st().doc.slices,
    sources: () => st().doc.sources,
    fromTick: fromTick ?? (st().positionTick >= end ? 0 : st().positionTick),
    loop,
    endTick: end,
    clickFadeMs: doc.clickFadeMs,
    beat: () => {
      const b = st().doc.beat;
      return b && b.enabled && b.fit.preview ? stablePreview({ notes: b.notes, lengthTicks: b.lengthTicks, gain: b.fit.previewGain }, b.notes) : null;
    },
    onTick: (t) => useStore.setState({ positionTick: t, playing: true }),
    onEnd: () => useStore.setState({ playing: false, positionTick: 0 }),
  });
  useStore.setState({ playing: true });
}

export function stop(reset = false) {
  engine.stop();
  engine.stopAudition();
  useStore.setState({ playing: false, ...(reset ? { positionTick: 0 } : {}) });
}

export function togglePlay() {
  if (st().playing) stop();
  else play();
}

/** Audition a candidate (or the arrangement with null) from the current position. */
export function audition(candidateId: string | null) {
  const was = st().playing;
  const pos = st().positionTick;
  st().setUI({ auditioning: candidateId });
  if (was) play(pos);
  else play(0);
}

/** Seamless A/B switch at the current position. */
export function swapAB() {
  const { ui } = st();
  if (!ui.candidateA || !ui.candidateB) return;
  const next = ui.auditioning === ui.candidateA ? ui.candidateB : ui.candidateA;
  audition(next);
}

export function seek(tick: number) {
  if (st().playing) play(tick);
  else useStore.setState({ positionTick: tick });
}

export function auditionSlice(sliceId: string, opts: { semitones?: number; reverse?: boolean } = {}) {
  const { doc } = st();
  const s = doc.slices.find((x) => x.id === sliceId);
  if (!s) return;
  const a = st().rt.audio.get(s.sourceId);
  if (!a) return;
  engine.setAudio(s.sourceId, a);
  engine.audition(s.sourceId, s.start, s.end, opts);
}

export function auditionRegion(sourceId: string, start: number, end: number) {
  const a = st().rt.audio.get(sourceId);
  if (!a) return;
  engine.setAudio(sourceId, a);
  engine.audition(sourceId, Math.max(0, Math.round(start)), Math.round(end));
}
