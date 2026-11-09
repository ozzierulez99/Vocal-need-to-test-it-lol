import type { SeqEvent, Slice, SourceAudio, Track, Sequence, TrackFilter } from '../types';
import { dbToGain, semitonesToRate, ticksToSeconds, clamp } from '../time';

/**
 * The playback plan is the single bridge between the sequence model and audio.
 * Both the real-time Web Audio engine and the offline WAV renderer consume it,
 * so what you hear is what you export.
 */
export interface PlannedEvent {
  eventId: string;
  trackId: string;
  sourceId: string;
  /** Timeline position in ticks (absolute). */
  tick: number;
  /** Seconds from timeline zero. */
  time: number;
  /** First source frame of the region that will be read. */
  srcStart: number;
  /** Number of source frames consumed. */
  srcFrames: number;
  reverse: boolean;
  rate: number;
  /** Output duration in seconds = srcFrames / (srcRate * rate). */
  duration: number;
  /** Linear gain (event × track). */
  gain: number;
  pan: number;
  fadeIn: number;
  fadeOut: number;
}

export interface PlanOptions {
  bpm: number;
  /** Minimum protective fade in ms applied to both ends of every event. */
  clickFadeMs: number;
  /** Render only these tracks (ignores mute/solo when given). */
  trackIds?: string[];
  respectMuteSolo?: boolean;
  /** Only events starting in [startTick, endTick). */
  startTick?: number;
  endTick?: number;
}

export function audibleTracks(tracks: Track[], opts: { trackIds?: string[]; respectMuteSolo?: boolean }): Set<string> {
  if (opts.trackIds) return new Set(opts.trackIds);
  const anySolo = tracks.some((t) => t.solo);
  const out = new Set<string>();
  for (const t of tracks) {
    if (opts.respectMuteSolo === false) out.add(t.id);
    else if (anySolo ? t.solo : !t.mute) out.add(t.id);
  }
  return out;
}

export function planEvent(
  ev: SeqEvent,
  slice: Slice,
  source: SourceAudio,
  track: Track | undefined,
  bpm: number,
  clickFadeMs: number,
): PlannedEvent | null {
  if (source.missing) return null;
  const sr = source.sampleRate;
  const rate = semitonesToRate(ev.semitones);
  const sliceStart = clamp(Math.round(slice.start), 0, source.frames);
  const sliceEnd = clamp(Math.round(slice.end), sliceStart, source.frames);
  const offset = clamp(Math.round(ev.offset), 0, Math.max(0, sliceEnd - sliceStart - 1));
  const available = sliceEnd - sliceStart - offset;
  if (available <= 0) return null;
  const gateSec = ticksToSeconds(Math.max(1, ev.length), bpm);
  const naturalSec = available / (sr * rate);
  const duration = Math.min(gateSec, naturalSec);
  const srcFrames = Math.max(1, Math.min(available, Math.round(duration * sr * rate)));
  // Reverse plays the chosen region backwards: offset is measured from the slice end.
  const srcStart = ev.reverse ? sliceEnd - offset - srcFrames : sliceStart + offset;
  const realDuration = srcFrames / (sr * rate);
  const guard = clickFadeMs / 1000;
  const half = realDuration / 2;
  const fadeIn = Math.min(half, Math.max(guard, ev.fadeIn / 1000));
  const fadeOut = Math.min(half, Math.max(guard, ev.fadeOut / 1000));
  return {
    eventId: ev.id,
    trackId: ev.trackId,
    sourceId: source.id,
    tick: ev.tick,
    time: ticksToSeconds(ev.tick, bpm),
    srcStart,
    srcFrames,
    reverse: ev.reverse,
    rate,
    duration: realDuration,
    gain: dbToGain(ev.gain) * (track ? dbToGain(track.gain) : 1),
    pan: clamp(ev.pan + (track?.pan ?? 0), -1, 1),
    fadeIn,
    fadeOut,
  };
}

export function buildPlan(
  seq: Pick<Sequence, 'events' | 'tracks'>,
  slices: Map<string, Slice> | Slice[],
  sources: Map<string, SourceAudio> | SourceAudio[],
  opts: PlanOptions,
): PlannedEvent[] {
  const sliceMap = slices instanceof Map ? slices : new Map(slices.map((s) => [s.id, s]));
  const srcMap = sources instanceof Map ? sources : new Map(sources.map((s) => [s.id, s]));
  const trackMap = new Map(seq.tracks.map((t) => [t.id, t]));
  const audible = audibleTracks(seq.tracks, opts);
  const out: PlannedEvent[] = [];
  for (const ev of seq.events) {
    if (!audible.has(ev.trackId)) continue;
    if (opts.startTick !== undefined && ev.tick < opts.startTick) continue;
    if (opts.endTick !== undefined && ev.tick >= opts.endTick) continue;
    const slice = sliceMap.get(ev.sliceId);
    if (!slice) continue;
    const src = srcMap.get(slice.sourceId);
    if (!src) continue;
    const p = planEvent(ev, slice, src, trackMap.get(ev.trackId), opts.bpm, opts.clickFadeMs);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.tick - b.tick || a.eventId.localeCompare(b.eventId));
  return out;
}

export function trackFilters(tracks: Track[]): Map<string, TrackFilter> {
  const m = new Map<string, TrackFilter>();
  for (const t of tracks) if (t.filter && t.filter.type !== 'off') m.set(t.id, t.filter);
  return m;
}

/** Stereo-panner gains identical to the Web Audio StereoPannerNode algorithm. */
export interface PanGains { mono: boolean; l: number; r: number; ll: number; rl: number; rr: number; lr: number }
export function panGains(pan: number, inputChannels: number): PanGains {
  const p = clamp(pan, -1, 1);
  if (inputChannels === 1) {
    const x = (p + 1) / 2;
    return { mono: true, l: Math.cos((x * Math.PI) / 2), r: Math.sin((x * Math.PI) / 2), ll: 0, rr: 0, lr: 0, rl: 0 };
  }
  if (p <= 0) {
    const x = p + 1;
    // outL = inL + inR*cos ; outR = inR*sin
    return { mono: false, ll: 1, rl: Math.cos((x * Math.PI) / 2), rr: Math.sin((x * Math.PI) / 2), lr: 0, l: 0, r: 0 } as const;
  }
  const x = p;
  // outL = inL*cos ; outR = inR + inL*sin
  return { mono: false, ll: Math.cos((x * Math.PI) / 2), rl: 0, rr: 1, lr: Math.sin((x * Math.PI) / 2), l: 0, r: 0 };
}
