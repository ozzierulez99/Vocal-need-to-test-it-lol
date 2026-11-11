import type { SeqEvent, Slice, SourceAudio, Track, Sequence, TrackFilter, Groove } from '../types';
import { PPQ } from '../types';
import { dbToGain, semitonesToRate, ticksToSeconds, clamp } from '../time';
import { hashString } from '../rng';

/**
 * The playback plan is the single bridge between the sequence model and audio.
 * Both the real-time Web Audio engine and the offline WAV renderer consume it,
 * so what you hear is what you export.
 */
export interface PlannedEvent {
  eventId: string;
  trackId: string;
  sourceId: string;
  /** Timeline position in ticks (absolute, the musical grid position). */
  tick: number;
  /** Seconds from timeline zero where the grid position falls (after swing/humanize). */
  gridTime: number;
  /** Seconds from timeline zero where audio actually starts (grid minus onset pre-roll). */
  time: number;
  /** First source frame of the region that will be read. */
  srcStart: number;
  /** Number of source frames available to this event (upper bound of what is read). */
  srcFrames: number;
  reverse: boolean;
  /** Base playback rate (the note's pitch). */
  rate: number;
  /** Output duration in seconds. */
  duration: number;
  /** Linear gain (event × track). */
  gain: number;
  pan: number;
  fadeIn: number;
  fadeOut: number;
  /** Pitch scoop: semitone offset at the start gliding to 0 over `sec`. */
  glideIn?: { semis: number; sec: number };
  /** Pitch fall/rise: 0 gliding to `semis` over the last `sec`. */
  glideOut?: { semis: number; sec: number };
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
  groove?: Groove;
}

/** Longest onset pre-roll honoured (seconds). */
export const MAX_PREROLL = 0.09;

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

/** Semitone offset of the pitch envelope at time t (seconds into the event). */
export function pitchEnvAt(p: Pick<PlannedEvent, 'glideIn' | 'glideOut' | 'duration'>, t: number): number {
  let st = 0;
  if (p.glideIn && p.glideIn.sec > 0 && t < p.glideIn.sec) st += p.glideIn.semis * (1 - t / p.glideIn.sec);
  if (p.glideOut && p.glideOut.sec > 0) {
    const s0 = p.duration - p.glideOut.sec;
    if (t > s0) st += p.glideOut.semis * Math.min(1, (t - s0) / p.glideOut.sec);
  }
  return st;
}

/** ∫ 2^((a + (b-a)·u/T)/12) du over a linear semitone ramp of length T seconds. */
function rampIntegral(a: number, b: number, T: number): number {
  if (T <= 0) return 0;
  const k = Math.LN2 / 12;
  if (Math.abs(b - a) < 1e-9) return T * Math.exp(k * a);
  return (T * (Math.exp(k * b) - Math.exp(k * a))) / (k * (b - a));
}

/**
 * Source frames consumed after `t` seconds of an event (exact integral of the
 * pitch envelope). Used for sizing, for starting playback mid-event, and tests.
 */
export function framesConsumed(p: Pick<PlannedEvent, 'glideIn' | 'glideOut' | 'duration' | 'rate'>, sr: number, t: number): number {
  const T = Math.max(0, Math.min(t, p.duration));
  if (!p.glideIn && !p.glideOut) return T * sr * p.rate;
  const gi = p.glideIn && p.glideIn.sec > 0 ? p.glideIn : null;
  const go = p.glideOut && p.glideOut.sec > 0 ? p.glideOut : null;
  // split at the envelope breakpoints; inside each piece both ramps are linear, so their sum is too
  const pts = [0, T];
  if (gi && gi.sec < T) pts.push(gi.sec);
  if (go && p.duration - go.sec > 0 && p.duration - go.sec < T) pts.push(p.duration - go.sec);
  pts.sort((x, y) => x - y);
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (b - a <= 0) continue;
    total += rampIntegral(pitchEnvAt(p, a + 1e-9), pitchEnvAt(p, b - 1e-9), b - a);
  }
  return total * sr * p.rate;
}

function grooveOffset(ev: SeqEvent, groove: Groove | undefined, bpm: number): { dt: number; gainDb: number } {
  if (!groove || (!groove.swing && !groove.humanize)) return { dt: 0, gainDb: 0 };
  const step = PPQ / 4;
  let dt = 0;
  let gainDb = 0;
  if (groove.swing) {
    const pos = ((ev.tick % (2 * step)) + 2 * step) % (2 * step);
    // only notes sitting on an off-beat sixteenth are swung (triplets and 32nds are left alone)
    if (Math.abs(pos - step) <= 12) dt += clamp(groove.swing, 0, 0.5) * ticksToSeconds(step, bpm);
  }
  if (groove.humanize) {
    const h = hashString(ev.id);
    const a = ((h & 0xffff) / 0xffff) * 2 - 1;
    const b = (((h >>> 16) & 0xffff) / 0xffff) * 2 - 1;
    // strong beats stay put; the rest breathe a little
    const onBeat = ev.tick % PPQ === 0;
    dt += a * groove.humanize * (onBeat ? 0.003 : 0.011);
    gainDb += b * groove.humanize * 1.5;
  }
  return { dt, gainDb };
}

export function planEvent(
  ev: SeqEvent,
  slice: Slice,
  source: SourceAudio,
  track: Track | undefined,
  bpm: number,
  clickFadeMs: number,
  groove?: Groove,
): PlannedEvent | null {
  if (source.missing) return null;
  const sr = source.sampleRate;
  const rate = semitonesToRate(ev.semitones);
  const sliceStart = clamp(Math.round(slice.start), 0, source.frames);
  const sliceEnd = clamp(Math.round(slice.end), sliceStart, source.frames);
  const offset = clamp(Math.round(ev.offset), 0, Math.max(0, sliceEnd - sliceStart - 1));
  const available = sliceEnd - sliceStart - offset;
  if (available <= 0) return null;
  const g = grooveOffset(ev, groove, bpm);
  const gridTime = Math.max(0, ticksToSeconds(ev.tick, bpm) + g.dt);
  // Onset alignment: start early so the slice's perceptual onset lands on the grid.
  let preFrames = 0;
  if (ev.align !== false && !ev.reverse && offset === 0 && slice.analysis?.onset) {
    preFrames = Math.min(slice.analysis.onset, MAX_PREROLL * sr, available - 1);
    if (preFrames < sr * 0.004) preFrames = 0;
  }
  let preSec = preFrames / (sr * rate);
  let time = gridTime - preSec;
  let lead = 0; // frames skipped because the pre-roll would start before time zero
  if (time < 0) {
    lead = Math.round(-time * sr * rate);
    time = 0;
    preSec = gridTime;
  }
  const avail = available - lead;
  const gateSec = ticksToSeconds(Math.max(1, ev.length), bpm) + preSec;
  const gIn = ev.glideIn && ev.glideIn[1] > 0 && ev.glideIn[0] !== 0 ? { semis: ev.glideIn[0], sec: ev.glideIn[1] / 1000 } : undefined;
  const gOut = ev.glideOut && ev.glideOut[1] > 0 && ev.glideOut[0] !== 0 ? { semis: ev.glideOut[0], sec: ev.glideOut[1] / 1000 } : undefined;
  let duration = Math.min(gateSec, avail / (sr * rate));
  let shape: Pick<PlannedEvent, 'glideIn' | 'glideOut' | 'duration' | 'rate'> = { rate, duration, glideIn: gIn, glideOut: gOut };
  if (gIn || gOut) {
    // with a pitch envelope the natural length changes: find the longest duration that fits the slice
    duration = gateSec;
    for (let i = 0; i < 6; i++) {
      shape = { rate, duration, glideIn: gIn && { ...gIn, sec: Math.min(gIn.sec, duration) }, glideOut: gOut && { ...gOut, sec: Math.min(gOut.sec, duration) } };
      const need = framesConsumed(shape, sr, duration);
      if (need <= avail) break;
      duration *= (avail / need) * 0.999;
    }
    shape = { rate, duration, glideIn: gIn && { ...gIn, sec: Math.min(gIn.sec, duration) }, glideOut: gOut && { ...gOut, sec: Math.min(gOut.sec, duration) } };
  }
  const used = gIn || gOut ? Math.min(avail, Math.ceil(framesConsumed(shape, sr, duration)) + 2) : Math.max(1, Math.min(avail, Math.round(duration * sr * rate)));
  if (!gIn && !gOut) duration = used / (sr * rate);
  // Reverse plays the chosen region backwards: offset is measured from the slice end.
  const srcStart = ev.reverse ? sliceEnd - offset - used : sliceStart + offset + lead;
  const guard = clickFadeMs / 1000;
  const half = duration / 2;
  const fadeIn = Math.min(half, Math.max(guard, ev.fadeIn / 1000));
  const fadeOut = Math.min(half, Math.max(guard, ev.fadeOut / 1000));
  return {
    eventId: ev.id,
    trackId: ev.trackId,
    sourceId: source.id,
    tick: ev.tick,
    gridTime,
    time,
    srcStart,
    srcFrames: used,
    reverse: ev.reverse,
    rate,
    duration,
    gain: dbToGain(ev.gain + g.gainDb) * (track ? dbToGain(track.gain) : 1),
    pan: clamp(ev.pan + (track?.pan ?? 0), -1, 1),
    fadeIn,
    fadeOut,
    glideIn: shape.glideIn,
    glideOut: shape.glideOut,
  };
}

export function buildPlan(
  seq: Pick<Sequence, 'events' | 'tracks'> & { groove?: Groove },
  slices: Map<string, Slice> | Slice[],
  sources: Map<string, SourceAudio> | SourceAudio[],
  opts: PlanOptions,
): PlannedEvent[] {
  const sliceMap = slices instanceof Map ? slices : new Map(slices.map((s) => [s.id, s]));
  const srcMap = sources instanceof Map ? sources : new Map(sources.map((s) => [s.id, s]));
  const trackMap = new Map(seq.tracks.map((t) => [t.id, t]));
  const audible = audibleTracks(seq.tracks, opts);
  const groove = opts.groove ?? seq.groove;
  const out: PlannedEvent[] = [];
  for (const ev of seq.events) {
    if (!audible.has(ev.trackId)) continue;
    if (opts.startTick !== undefined && ev.tick < opts.startTick) continue;
    if (opts.endTick !== undefined && ev.tick >= opts.endTick) continue;
    const slice = sliceMap.get(ev.sliceId);
    if (!slice) continue;
    const src = srcMap.get(slice.sourceId);
    if (!src) continue;
    const p = planEvent(ev, slice, src, trackMap.get(ev.trackId), opts.bpm, opts.clickFadeMs, groove);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.time - b.time || a.tick - b.tick || a.eventId.localeCompare(b.eventId));
  // Choke: on sampler-style layers a new note cuts everything that started before it (with a short fade).
  const open = new Map<string, PlannedEvent[]>();
  for (const p of out) {
    const t = trackMap.get(p.trackId);
    if (!t?.choke) continue;
    const list = open.get(p.trackId) ?? [];
    const still: PlannedEvent[] = [];
    for (const prev of list) {
      if (p.gridTime <= prev.gridTime + 0.002) {
        still.push(prev); // same onset: a stack, not a new note
        continue;
      }
      if (prev.time + prev.duration > p.time) {
        prev.duration = Math.max(0.004, p.time - prev.time);
        prev.fadeOut = Math.min(prev.duration / 2, Math.max(0.004, Math.min(prev.fadeOut, 0.012)));
        prev.fadeIn = Math.min(prev.fadeIn, prev.duration / 2);
        if (prev.glideOut) prev.glideOut = { ...prev.glideOut, sec: Math.min(prev.glideOut.sec, prev.duration) };
      }
    }
    still.push(p);
    open.set(p.trackId, still);
  }
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
