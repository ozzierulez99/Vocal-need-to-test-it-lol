import type { AudioData, Slice, SourceAudio, Sequence } from '../src/core/types';
import { demoVoice } from '../src/core/demo/synthVoice';
import { autoChop, makeSlice } from '../src/core/slicing/slices';
import { emptySequence } from '../src/core/project/project';

export function sourceFor(id: string, a: AudioData, extra: Partial<SourceAudio> = {}): SourceAudio {
  return { id, name: id, assetName: `${id}.wav`, kind: 'import', sampleRate: a.sampleRate, channelCount: a.channels.length, frames: a.channels[0].length, createdAt: 0, ...extra };
}

let cache: { sources: SourceAudio[]; slices: Slice[]; audio: Map<string, AudioData> } | null = null;
export function demoProject() {
  if (cache) return cache;
  const sources: SourceAudio[] = [];
  const slices: Slice[] = [];
  const audio = new Map<string, AudioData>();
  for (const n of ['sung-phrase', 'spoken-phrase', 'hum-whisper', 'voice-b', 'chop-attacks']) {
    const a = demoVoice(n);
    const s = sourceFor(n, a);
    sources.push(s);
    audio.set(n, a);
    slices.push(...autoChop(s, a, { prefix: n.slice(0, 2) }).slices);
  }
  cache = { sources, slices, audio };
  return cache;
}

export const slicesOf = (src: string) => demoProject().slices.filter((s) => s.sourceId === src).map((s) => s.id);

/** Constant DC source so rendered values are easy to predict. */
export function constSource(id: string, frames: number, value = 0.5, sampleRate = 44100, channels = 1): { src: SourceAudio; audio: AudioData } {
  const a: AudioData = { sampleRate, channels: Array.from({ length: channels }, () => new Float32Array(frames).fill(value)) };
  return { src: sourceFor(id, a), audio: a };
}

/** Ramp source: sample i has value i/frames, lets tests verify which region was read. */
export function rampSource(id: string, frames: number, sampleRate = 44100): { src: SourceAudio; audio: AudioData } {
  const ch = new Float32Array(frames);
  for (let i = 0; i < frames; i++) ch[i] = i / frames;
  const a = { sampleRate, channels: [ch] };
  return { src: sourceFor(id, a), audio: a };
}

export function seqWith(partial: Partial<Sequence>): Sequence {
  return { ...emptySequence(), ...partial };
}

export function sliceOf(src: SourceAudio, start: number, end: number, id = 'sl1'): Slice {
  return makeSlice(src, start, end, 'syllable', { id, name: id });
}
