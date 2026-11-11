import type { AudioData, Sequence, Slice, SourceAudio, Track } from '../../core/types';
import { buildPlan, framesConsumed, pitchEnvAt, type PlannedEvent } from '../../core/audio/plan';
import { ticksToSeconds, secondsToTicks, dbToGain } from '../../core/time';
import { envelopeAt } from '../../core/audio/render';

/**
 * Real-time playback built on Web Audio. It consumes the same PlannedEvent list
 * as the offline renderer and schedules AudioBufferSourceNodes with a lookahead
 * scheduler (sample-accurate start times on the audio clock).
 */
type SeqLike = Pick<Sequence, 'events' | 'tracks' | 'bpm'> & { groove?: Sequence['groove'] };

export interface PlayRequest {
  seq: () => SeqLike;
  slices: () => Slice[];
  sources: () => SourceAudio[];
  fromTick: number;
  loop: { startTick: number; endTick: number } | null;
  endTick: number;
  clickFadeMs: number;
  onTick?: (tick: number) => void;
  onEnd?: () => void;
  /** Optional beat preview (MIDI notes looped every lengthTicks), never exported. */
  beat?: () => { notes: { tick: number; length: number; pitch: number; velocity: number; drum?: boolean }[]; lengthTicks: number; gain: number } | null;
  /** Optional audio bounce of the beat (sourceId registered with setAudio), never exported. */
  backing?: () => { sourceId: string; gain: number; offsetSec: number } | null;
  /** Audition effects on the vocal chops (monitoring). */
  fx?: () => { reverb: number; delay: number } | null;
}

interface SynthNote {
  time: number;
  duration: number;
  pitch: number;
  velocity: number;
  gain: number;
  drum?: boolean;
}

interface BackingSeg {
  time: number;
  duration: number;
  /** seconds into the backing audio */
  from: number;
  sourceId: string;
  gain: number;
}

/** Synthetic reverb impulse (decaying noise) – enough to judge a chop "in a space". */
export function makeImpulse(ctx: BaseAudioContext, seconds = 2.6): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    let seed = 1234567 + c * 7919;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = (seed / 4294967296) * 2 - 1;
      lp += 0.35 * (white - lp); // darker tail
      const t = i / n;
      d[i] = lp * Math.pow(1 - t, 2.2) * (i < 400 ? i / 400 : 1);
    }
  }
  return buf;
}

/** Wires dry + reverb + tempo delay for the vocal bus. Returns the input node. */
export function buildFx(ctx: BaseAudioContext, out: AudioNode, bpm: number, fx: { reverb: number; delay: number }, impulse: AudioBuffer): { input: GainNode; reverb: GainNode; delay: GainNode } {
  const input = ctx.createGain();
  input.connect(out);
  const reverb = ctx.createGain();
  reverb.gain.value = fx.reverb * 0.9;
  const conv = ctx.createConvolver();
  conv.buffer = impulse;
  input.connect(reverb).connect(conv).connect(out);
  const delay = ctx.createGain();
  delay.gain.value = fx.delay * 0.7;
  const dl = ctx.createDelay(2);
  dl.delayTime.value = Math.min(1.9, (60 / bpm) * 0.75); // dotted eighth
  const fb = ctx.createGain();
  fb.gain.value = 0.42;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 3800;
  input.connect(delay).connect(dl).connect(tone).connect(out);
  tone.connect(fb).connect(dl);
  return { input, reverb, delay };
}

class AudioEngine {
  ctx: AudioContext | null = null;
  private forward = new Map<string, AudioBuffer>();
  private reversed = new Map<string, AudioBuffer>();
  private dataRef = new Map<string, AudioData>();
  private session: Session | null = null;
  private auditionNodes: { src: AudioBufferSourceNode; gain: GainNode }[] = [];
  /** When enabled (tests/diagnostics) every scheduled node is recorded relative to the session start. */
  debugSchedule: { eventId: string; at: number; offset: number; duration: number; rate: number }[] | null = null;
  debugSynth: { pitch: number; at: number; duration: number }[] | null = null;
  debugBacking: { at: number; from: number; duration: number }[] | null = null;
  private ir: AudioBuffer | null = null;
  impulse(): AudioBuffer {
    if (!this.ir || this.ir.sampleRate !== this.context().sampleRate) this.ir = makeImpulse(this.context());
    return this.ir;
  }
  /** Last audition (for drawing a moving cursor on the waveform). */
  auditionInfo: { sourceId: string; start: number; end: number; t0: number; dur: number; rate: number; reverse: boolean } | null = null;

  context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Register decoded audio for a source (buffers are created lazily and cached). */
  setAudio(sourceId: string, data: AudioData) {
    if (this.dataRef.get(sourceId) === data) return;
    this.dataRef.set(sourceId, data);
    this.forward.delete(sourceId);
    this.reversed.delete(sourceId);
  }

  buffer(sourceId: string, reverse = false): AudioBuffer | null {
    const cache = reverse ? this.reversed : this.forward;
    const hit = cache.get(sourceId);
    if (hit) return hit;
    const data = this.dataRef.get(sourceId);
    if (!data) return null;
    const ctx = this.context();
    const n = data.channels[0].length;
    const buf = ctx.createBuffer(data.channels.length, Math.max(1, n), data.sampleRate);
    data.channels.forEach((ch, c) => {
      if (!reverse) buf.copyToChannel(ch as Float32Array<ArrayBuffer>, c);
      else {
        const r = new Float32Array(n);
        for (let i = 0; i < n; i++) r[i] = ch[n - 1 - i];
        buf.copyToChannel(r, c);
      }
    });
    cache.set(sourceId, buf);
    return buf;
  }

  get isPlaying() {
    return !!this.session;
  }

  play(req: PlayRequest) {
    this.stop();
    this.session = new Session(this, req);
    this.session.start();
  }

  stop() {
    this.session?.stop();
    this.session = null;
  }

  currentTick(): number | null {
    return this.session?.currentTick() ?? null;
  }

  /** Immediate audition of a source region (slice preview), with click-free fades. */
  audition(sourceId: string, start: number, end: number, opts: { reverse?: boolean; semitones?: number; gainDb?: number; fadeMs?: number } = {}) {
    this.stopAudition();
    const ctx = this.context();
    const data = this.dataRef.get(sourceId);
    const buf = this.buffer(sourceId, !!opts.reverse);
    if (!buf || !data) return;
    const sr = data.sampleRate;
    const frames = Math.max(1, end - start);
    const offset = opts.reverse ? data.channels[0].length - end : start;
    const rate = Math.pow(2, (opts.semitones ?? 0) / 12);
    const dur = frames / sr / rate;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    const t = ctx.currentTime + 0.01;
    const f = Math.min(dur / 2, (opts.fadeMs ?? 4) / 1000);
    const level = dbToGain(opts.gainDb ?? 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + f);
    g.gain.setValueAtTime(level, t + dur - f);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(g).connect(ctx.destination);
    src.start(t, offset / sr, frames / sr);
    src.stop(t + dur + 0.02);
    this.auditionInfo = { sourceId, start, end, t0: t, dur, rate, reverse: !!opts.reverse };
    const node = { src, gain: g };
    this.auditionNodes.push(node);
    src.onended = () => {
      this.auditionNodes = this.auditionNodes.filter((n) => n !== node);
    };
  }

  stopAudition() {
    const ctx = this.ctx;
    for (const n of this.auditionNodes) {
      try {
        if (ctx) {
          n.gain.gain.cancelScheduledValues(ctx.currentTime);
          n.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
          n.src.stop(ctx.currentTime + 0.03);
        }
      } catch {
        /* already stopped */
      }
    }
    this.auditionNodes = [];
    this.auditionInfo = null;
  }
}

class Session {
  private ctx: AudioContext;
  private master: GainNode;
  private buses = new Map<string, AudioNode>();
  private startTime = 0;
  private originTick = 0;
  private timer: number | null = null;
  private raf: number | null = null;
  private scheduledUntil = 0; // seconds of timeline (unwrapped)
  private nodes = new Set<AudioBufferSourceNode>();
  private planCache: { key: unknown; plan: PlannedEvent[] } | null = null;
  private stopped = false;
  private lastTracks: Track[] | null = null;

  private out: GainNode;
  private fx: { input: GainNode; reverb: GainNode; delay: GainNode } | null = null;
  private fxTimer: number | null = null;

  constructor(private engine: AudioEngine, private req: PlayRequest) {
    this.ctx = engine.context();
    // out = everything (stopped/faded together); master = vocal chops (optionally through audition FX)
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    const fx = req.fx?.() ?? null;
    if (req.fx) {
      this.fx = buildFx(this.ctx, this.out, req.seq().bpm, fx ?? { reverb: 0, delay: 0 }, engine.impulse());
      this.master.connect(this.fx.input);
      // follow the send knobs live
      this.fxTimer = window.setInterval(() => {
        const v = this.req.fx?.();
        if (!v || !this.fx) return;
        this.fx.reverb.gain.setTargetAtTime(v.reverb * 0.9, this.ctx.currentTime, 0.05);
        this.fx.delay.gain.setTargetAtTime(v.delay * 0.7, this.ctx.currentTime, 0.05);
      }, 120);
    } else this.master.connect(this.out);
  }

  private plan(): PlannedEvent[] {
    const seq = this.req.seq();
    if (this.planCache && this.planCache.key === seq) return this.planCache.plan;
    const plan = buildPlan(seq, this.req.slices(), this.req.sources(), { bpm: seq.bpm, clickFadeMs: this.req.clickFadeMs });
    this.planCache = { key: seq, plan };
    if (this.lastTracks !== seq.tracks) this.rebuildBuses(seq.tracks);
    return plan;
  }

  private rebuildBuses(tracks: Track[]) {
    this.lastTracks = tracks;
    for (const t of tracks) {
      const want = t.filter && t.filter.type !== 'off';
      const cur = this.buses.get(t.id);
      if (!want) {
        this.buses.set(t.id, this.master);
        continue;
      }
      if (cur && cur !== this.master && cur instanceof BiquadFilterNode) {
        cur.type = t.filter!.type as BiquadFilterType;
        cur.frequency.value = t.filter!.frequency;
        continue;
      }
      const f = this.ctx.createBiquadFilter();
      f.type = t.filter!.type as BiquadFilterType;
      f.frequency.value = t.filter!.frequency;
      f.Q.value = Math.SQRT1_2;
      f.connect(this.master);
      this.buses.set(t.id, f);
    }
  }

  private loopLen(): number {
    const { loop } = this.req;
    const bpm = this.req.seq().bpm;
    return loop ? ticksToSeconds(loop.endTick - loop.startTick, bpm) : Infinity;
  }

  /** Convert unwrapped elapsed seconds to a timeline tick. */
  private tickAt(elapsed: number): number {
    const bpm = this.req.seq().bpm;
    const { loop } = this.req;
    const t0 = ticksToSeconds(this.originTick, bpm);
    if (!loop) return this.originTick + secondsToTicks(elapsed, bpm);
    const ls = ticksToSeconds(loop.startTick, bpm);
    const len = this.loopLen();
    let pos = t0 + elapsed;
    if (pos >= ls + len) pos = ls + ((pos - ls) % len);
    return secondsToTicks(pos, bpm);
  }

  currentTick(): number {
    return this.tickAt(Math.max(0, this.ctx.currentTime - this.startTime));
  }

  start() {
    const { fromTick, loop } = this.req;
    this.originTick = loop && (fromTick < loop.startTick || fromTick >= loop.endTick) ? loop.startTick : fromTick;
    this.startTime = this.ctx.currentTime + 0.06;
    this.scheduledUntil = 0;
    this.pump();
    this.timer = window.setInterval(() => this.pump(), 25);
    const tick = () => {
      if (this.stopped) return;
      const t = this.currentTick();
      this.req.onTick?.(t);
      const bpm = this.req.seq().bpm;
      if (!this.req.loop && this.ctx.currentTime - this.startTime > ticksToSeconds(this.req.endTick - this.originTick, bpm) + 0.1) {
        this.engine.stop();
        this.req.onEnd?.();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Schedule everything that starts inside the next lookahead window. */
  private pump() {
    if (this.stopped) return;
    const ahead = 0.18;
    const now = this.ctx.currentTime - this.startTime;
    const until = now + ahead;
    if (until <= this.scheduledUntil) return;
    const from = this.scheduledUntil;
    this.forEachDue(this.plan(), from, until, (p, when, skip, maxDur) => this.scheduleEvent(p, when, skip, maxDur));
    const synth = this.beatNotes();
    if (synth.length) this.forEachDue(synth, from, until, (n, when, skip, maxDur) => (n.drum ? this.scheduleDrum(n, when, skip) : this.scheduleSynth(n, when, skip, maxDur)));
    const backing = this.backingSegs();
    if (backing.length) this.forEachDue(backing, from, until, (seg, when, skip, maxDur) => this.scheduleBacking(seg, when, skip, maxDur));
    this.scheduledUntil = until;
  }

  /**
   * Calls `cb` for every item (timeline seconds) that must start in the window
   * [from, until) of elapsed playback time, handling a start from the middle of
   * an item and loop cycles. `skip` = seconds already elapsed inside the item.
   */
  private forEachDue<T extends { time: number; duration: number; gridTime?: number }>(items: T[], from: number, until: number, cb: (item: T, when: number, skip: number, maxDur: number) => void) {
    const bpm = this.req.seq().bpm;
    const loop = this.req.loop && this.req.loop.endTick > this.req.loop.startTick ? this.req.loop : null;
    const t0 = ticksToSeconds(this.originTick, bpm);
    if (!loop) {
      const end = ticksToSeconds(this.req.endTick, bpm);
      for (const p of items) {
        const rel = p.time - t0;
        if (from === 0 && rel < 0 && p.time + p.duration > t0) cb(p, this.startTime, t0 - p.time, Infinity);
        else if (rel >= from && rel < until && (p.gridTime ?? p.time) < end) cb(p, this.startTime + rel, 0, Infinity);
      }
      return;
    }
    const ls = ticksToSeconds(loop.startTick, bpm);
    const le = ticksToSeconds(loop.endTick, bpm);
    const len = le - ls;
    // first (partial) pass from origin to loop end, then full cycles
    for (const p of items) {
      const grid = p.gridTime ?? p.time; // membership by musical position; audio may pre-roll slightly earlier
      if (grid < ls - 1e-9 || grid >= le) continue;
      const firstRel = p.time - t0;
      if (from === 0 && firstRel < 0 && p.time + p.duration > t0) cb(p, this.startTime, t0 - p.time, le - p.time);
      // occurrence k: k = 0 is the first pass (from the origin), k ≥ 1 are full loop cycles
      const k0 = Math.max(firstRel >= 0 ? 0 : 1, Math.floor((from - (le - t0) - (p.time - ls)) / len) + 1);
      for (let k = k0; k < k0 + 10000; k++) {
        const occ = k === 0 ? firstRel : le - t0 + (k - 1) * len + (p.time - ls);
        if (occ >= until) break;
        if (occ >= from) cb(p, this.startTime + occ, 0, le - p.time);
      }
    }
  }

  private beatCache: { key: unknown; bpm: number; end: number; notes: SynthNote[] } | null = null;

  /** The beat's MIDI tiled over the arrangement, in seconds (for the preview synth). */
  private beatNotes(): SynthNote[] {
    const b = this.req.beat?.();
    if (!b) return [];
    const bpm = this.req.seq().bpm;
    if (this.beatCache && this.beatCache.key === b && this.beatCache.bpm === bpm && this.beatCache.end === this.req.endTick) return this.beatCache.notes;
    const notes: SynthNote[] = [];
    for (let base = 0; base < this.req.endTick; base += b.lengthTicks)
      for (const n of b.notes) {
        const tick = base + n.tick;
        if (tick >= this.req.endTick) continue;
        notes.push({ time: ticksToSeconds(tick, bpm), duration: ticksToSeconds(Math.min(n.length, this.req.endTick - tick), bpm), pitch: n.pitch, velocity: n.velocity, gain: b.gain, drum: n.drum });
      }
    this.beatCache = { key: b, bpm, end: this.req.endTick, notes };
    return notes;
  }

  private backingCache: { key: unknown; bpm: number; end: number; segs: BackingSeg[] } | null = null;

  /** The backing audio cut into one-bar pieces so it loops and seeks with the arrangement. */
  private backingSegs(): BackingSeg[] {
    const b = this.req.backing?.();
    if (!b) return [];
    const bpm = this.req.seq().bpm;
    if (this.backingCache && this.backingCache.key === b && this.backingCache.bpm === bpm && this.backingCache.end === this.req.endTick) return this.backingCache.segs;
    const data = this.engineData(b.sourceId);
    const segs: BackingSeg[] = [];
    if (data) {
      const total = data.channels[0].length / data.sampleRate;
      const end = ticksToSeconds(this.req.endTick, bpm);
      const piece = (60 / bpm) * 4;
      for (let t = 0; t < end - 1e-6; t += piece) {
        const from = t - b.offsetSec;
        if (from + piece <= 0 || from >= total) continue;
        const lead = Math.max(0, -from);
        segs.push({ time: t + lead, duration: Math.min(piece - lead, total - Math.max(0, from), end - t - lead), from: Math.max(0, from), sourceId: b.sourceId, gain: b.gain });
      }
    }
    this.backingCache = { key: b, bpm, end: this.req.endTick, segs };
    return segs;
  }

  private scheduleBacking(seg: BackingSeg, when: number, skip: number, maxDur: number) {
    const buf = this.engine.buffer(seg.sourceId);
    if (!buf) return;
    const ctx = this.ctx;
    const x = 0.008; // crossfade between neighbouring pieces
    const dur = Math.min(seg.duration, maxDur) - skip;
    if (dur <= 0.002) return;
    const t = Math.max(when, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const level = dbToGain(seg.gain);
    const pre = skip === 0 && seg.from > x ? x : 0; // start a touch early and fade in under the previous piece
    g.gain.setValueAtTime(pre ? 0 : level, Math.max(ctx.currentTime, t - pre));
    if (pre) g.gain.linearRampToValueAtTime(level, t);
    g.gain.setValueAtTime(level, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + x);
    src.connect(g).connect(this.out);
    src.start(Math.max(ctx.currentTime, t - pre), Math.max(0, seg.from + skip - pre), dur + x + pre);
    this.nodes.add(src);
    src.onended = () => this.nodes.delete(src);
    this.engine.debugBacking?.push({ at: t - this.startTime, from: seg.from + skip, duration: dur });
  }

  private noise: AudioBuffer | null = null;

  /** Tiny drum machine for the beat preview: kick, snare/clap, hats. */
  private scheduleDrum(n: SynthNote, when: number, skip: number) {
    if (skip > 0.02) return;
    const ctx = this.ctx;
    const t = Math.max(when, ctx.currentTime);
    if (!this.beatBus) this.ensureBeatBus();
    const level = dbToGain(n.gain) * (0.4 + 0.6 * n.velocity);
    const g = ctx.createGain();
    g.connect(this.beatBus!);
    if (n.pitch === 35 || n.pitch === 36) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(level * 0.9, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.3);
      this.synthNodes.add(o);
      o.onended = () => this.synthNodes.delete(o);
    } else {
      if (!this.noise) {
        this.noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        let seed = 99;
        for (let i = 0; i < d.length; i++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          d[i] = (seed / 4294967296) * 2 - 1;
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      const snare = n.pitch >= 37 && n.pitch <= 40;
      f.type = snare ? 'bandpass' : 'highpass';
      f.frequency.value = snare ? 1800 : 7000;
      const len = snare ? 0.16 : n.pitch === 46 ? 0.2 : 0.045;
      g.gain.setValueAtTime(level * (snare ? 0.55 : 0.25), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      src.connect(f).connect(g);
      src.start(t, 0, len + 0.02);
      this.nodes.add(src);
      src.onended = () => this.nodes.delete(src);
    }
    this.engine.debugSynth?.push({ pitch: n.pitch, at: t - this.startTime, duration: 0.05 });
  }

  private ensureBeatBus() {
    this.beatBus = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9000;
    this.beatBus.connect(lp).connect(this.out);
    this.beatPitched = this.ctx.createBiquadFilter();
    this.beatPitched.type = 'lowpass';
    this.beatPitched.frequency.value = 2400;
    this.beatPitched.connect(this.beatBus);
  }

  private beatPitched: BiquadFilterNode | null = null;
  private beatBus: GainNode | null = null;

  /** Simple soft synth voice: two detuned triangles through a low-pass, ADSR on a gain. */
  private scheduleSynth(n: SynthNote, when: number, skip: number, maxDur: number) {
    const ctx = this.ctx;
    const dur = Math.min(n.duration, maxDur) - skip;
    if (dur <= 0.005) return;
    if (!this.beatBus) this.ensureBeatBus();
    const t = Math.max(when, ctx.currentTime);
    const f = 440 * Math.pow(2, (n.pitch - 69) / 12);
    const g = ctx.createGain();
    const peak = dbToGain(n.gain) * (0.25 + 0.5 * n.velocity) * 0.35;
    const rel = Math.min(0.12, dur * 0.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(0.012, dur / 3));
    g.gain.linearRampToValueAtTime(peak * 0.6, t + Math.min(0.25, dur - rel));
    g.gain.setValueAtTime(peak * 0.6, t + dur - rel);
    g.gain.linearRampToValueAtTime(0, t + dur);
    g.connect(this.beatPitched!);
    for (const det of [-4, 4]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.02);
      this.synthNodes.add(o);
      o.onended = () => this.synthNodes.delete(o);
    }
    this.engine.debugSynth?.push({ pitch: n.pitch, at: t - this.startTime, duration: dur });
  }

  private synthNodes = new Set<OscillatorNode>();

  private scheduleEvent(p: PlannedEvent, when: number, skip: number, maxDur = Infinity) {
    const data = this.engineData(p.sourceId);
    const buf = this.engine.buffer(p.sourceId, p.reverse);
    if (!buf || !data) return;
    const sr = data.sampleRate;
    const total = data.channels[0].length;
    const dur = Math.min(p.duration, maxDur);
    if (skip >= dur) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = p.rate;
    const g = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = p.pan;
    const startFrame = p.reverse ? total - (p.srcStart + p.srcFrames) : p.srcStart;
    const glide = !!(p.glideIn || p.glideOut);
    const consumed = glide ? framesConsumed(p, sr, skip) : skip * p.rate * sr;
    const offsetSec = startFrame / sr + consumed / sr;
    const remaining = dur - skip;
    const fadeOut = Math.min(p.fadeOut, dur / 2);
    const t = Math.max(when, ctx.currentTime);
    // envelope identical to the offline renderer (linear ramps)
    g.gain.setValueAtTime(p.gain * envelopeAt(skip, dur, p.fadeIn, fadeOut), t);
    if (skip < p.fadeIn) g.gain.linearRampToValueAtTime(p.gain, t + (p.fadeIn - skip));
    const fo = t + remaining - fadeOut;
    if (fo > t) g.gain.setValueAtTime(p.gain * envelopeAt(dur - fadeOut, dur, p.fadeIn, fadeOut), fo);
    g.gain.linearRampToValueAtTime(0, t + remaining);
    src.connect(g).connect(pan).connect(this.buses.get(p.trackId) ?? this.master);
    if (glide) {
      // pitch envelope: linear in semitones = exponential in playback rate (same curve as the renderer)
      const r = src.playbackRate;
      r.setValueAtTime(p.rate * Math.pow(2, pitchEnvAt(p, skip) / 12), t);
      if (p.glideIn && skip < p.glideIn.sec) r.exponentialRampToValueAtTime(p.rate, t + (p.glideIn.sec - skip));
      if (p.glideOut) {
        const s0 = p.duration - p.glideOut.sec;
        if (s0 > skip) r.setValueAtTime(p.rate, t + (s0 - skip));
        r.exponentialRampToValueAtTime(p.rate * Math.pow(2, p.glideOut.semis / 12), t + (p.duration - skip));
      }
      src.start(t, offsetSec, Math.max(0.001, (p.srcFrames - consumed) / sr));
    } else src.start(t, offsetSec, remaining * p.rate);
    this.engine.debugSchedule?.push({ eventId: p.eventId, at: t - this.startTime, offset: offsetSec, duration: remaining, rate: p.rate });
    src.stop(t + remaining + 0.01);
    this.nodes.add(src);
    src.onended = () => this.nodes.delete(src);
  }

  private engineData(id: string) {
    return (this.engine as any).dataRef.get(id) as AudioData | undefined;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.raf) cancelAnimationFrame(this.raf);
    const now = this.ctx.currentTime;
    if (this.fxTimer) clearInterval(this.fxTimer);
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(0, now + 0.012);
    for (const n of this.nodes) {
      try {
        n.stop(now + 0.015);
      } catch {
        /* not started */
      }
    }
    this.nodes.clear();
    for (const o of this.synthNodes) {
      try {
        o.stop(now + 0.015);
      } catch {
        /* not started */
      }
    }
    this.synthNodes.clear();
    setTimeout(() => {
      try {
        this.out.disconnect();
        this.master.disconnect();
        for (const b of this.buses.values()) if (b !== this.master) b.disconnect();
      } catch {
        /* ignore */
      }
    }, 60);
  }
}

export const engine = new AudioEngine();
(globalThis as any).__vcsEngine = engine;
