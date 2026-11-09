import type { AudioData, ExportSettings, ProjectDoc, Sequence, Slice } from '../types';
import { encodeWav, sliceAudio } from '../audio/wav';
import { renderSequence, resample, type RenderResult } from '../audio/render';
import { exportTriggerMidi, exportPitchMidi, mappingText, safeName } from '../midi/midi';
import { ticksPerBar } from '../time';
import { strToU8 } from 'fflate';

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
}

export interface MixOptions {
  /** Bars [start, end) – defaults to the whole arrangement. */
  startBar?: number;
  endBar?: number;
  trackIds?: string[];
  /** loop-ready rendering folds the tail back to the start */
  loopReady?: boolean;
}

export function renderMix(doc: ProjectDoc, audio: Map<string, AudioData>, s: ExportSettings, o: MixOptions = {}): RenderResult {
  const seq = doc.sequence;
  const bar = ticksPerBar(seq.timeSig);
  return renderSequence(seq, doc.slices, doc.sources, audio, {
    sampleRate: s.sampleRate,
    clickFadeMs: s.clickFadeMs,
    startTick: (o.startBar ?? 0) * bar,
    endTick: (o.endBar ?? seq.bars) * bar,
    trackIds: o.trackIds,
    respectMuteSolo: !o.trackIds,
    tail: o.loopReady ? 'wrap' : s.tail,
    level: s.level,
  });
}

const base = (doc: ProjectDoc) => safeName(doc.name || 'vocal-chop');

export function exportMixFile(doc: ProjectDoc, audio: Map<string, AudioData>, s: ExportSettings, o: MixOptions = {}): ExportFile & { result: RenderResult } {
  const r = renderMix(doc, audio, s, o);
  const range = o.startBar !== undefined || o.endBar !== undefined ? `_bars${(o.startBar ?? 0) + 1}-${o.endBar ?? doc.sequence.bars}` : '';
  const name = `${base(doc)}_${doc.sequence.bpm}bpm${range}${o.loopReady ? '_loop' : ''}_${s.sampleRate / 1000}k${s.bitDepth}.wav`;
  return { name, bytes: encodeWav(r.audio, s.bitDepth), result: r };
}

/** One WAV per layer, all the same length so they line up in a DAW. */
export function exportStems(doc: ProjectDoc, audio: Map<string, AudioData>, s: ExportSettings, o: MixOptions = {}): ExportFile[] {
  const seq = doc.sequence;
  const used = seq.tracks.filter((t) => seq.events.some((e) => e.trackId === t.id));
  // Use a shared length and a shared (never per-stem) gain so stems sum to the mix.
  const settings: ExportSettings = { ...s, level: 'none', tail: o.loopReady ? 'wrap' : 'keep' };
  const renders = used.map((t) => ({ t, r: renderMix(doc, audio, settings, { ...o, trackIds: [t.id] }) }));
  const maxLen = Math.max(0, ...renders.map((x) => x.r.audio.channels[0].length));
  const peak = Math.max(0, ...renders.map((x) => x.r.peak));
  const g = s.level === 'none' ? 1 : peak > 0.989 ? 0.989 / peak : 1;
  return renders.map(({ t, r }, i) => {
    const ch = r.audio.channels.map((c) => {
      const out = new Float32Array(maxLen);
      for (let k = 0; k < c.length; k++) out[k] = c[k] * g;
      return out;
    });
    return { name: `${base(doc)}_${String(i + 1).padStart(2, '0')}_${safeName(t.name)}_${seq.bpm}bpm.wav`, bytes: encodeWav({ sampleRate: r.audio.sampleRate, channels: ch }, s.bitDepth) };
  });
}

export function sliceToAudio(slice: Slice, src: AudioData, s: Pick<ExportSettings, 'sampleRate' | 'clickFadeMs'>): AudioData {
  const a = resample(sliceAudio(src, slice.start, slice.end), s.sampleRate);
  const fade = Math.min(Math.floor(a.channels[0].length / 2), Math.round((s.clickFadeMs / 1000) * s.sampleRate));
  for (const ch of a.channels) {
    for (let i = 0; i < fade; i++) {
      const g = i / fade;
      ch[i] *= g;
      ch[ch.length - 1 - i] *= g;
    }
  }
  return a;
}

export function exportSlices(doc: ProjectDoc, audio: Map<string, AudioData>, sliceIds: string[], s: ExportSettings, names?: Map<string, string>): ExportFile[] {
  const files: ExportFile[] = [];
  sliceIds.forEach((id, i) => {
    const sl = doc.slices.find((x) => x.id === id);
    if (!sl) return;
    const src = audio.get(sl.sourceId);
    if (!src) return;
    files.push({ name: names?.get(id) ?? `${String(i + 1).padStart(2, '0')}_${safeName(sl.name)}.wav`, bytes: encodeWav(sliceToAudio(sl, src, s), s.bitDepth) });
  });
  return files;
}

/** MIDI + slice WAVs + human-readable and JSON mappings, ready for a DAW sampler. */
export function exportMidiPackage(doc: ProjectDoc, audio: Map<string, AudioData>, s: ExportSettings, kind: 'trigger' | 'pitch', trackIds?: string[]): ExportFile[] {
  const seq: Sequence = doc.sequence;
  const events = seq.events.filter((e) => !trackIds || trackIds.includes(e.trackId));
  const tracks = seq.tracks.filter((t) => !trackIds || trackIds.includes(t.id));
  const r = kind === 'trigger' ? exportTriggerMidi(events, tracks, doc.slices, doc.sources, seq.bpm, seq.timeSig) : exportPitchMidi(events, doc.slices, seq.bpm, seq.timeSig);
  const names = new Map(r.mapping.map((m) => [m.sliceId, m.fileName]));
  const ids = r.mapping.map((m) => m.sliceId);
  return [
    { name: `${base(doc)}_${kind}.mid`, bytes: r.bytes },
    { name: `${base(doc)}_${kind}_mapping.txt`, bytes: strToU8(mappingText(r.mapping, kind, seq.bpm)) },
    { name: `${base(doc)}_${kind}_mapping.json`, bytes: strToU8(JSON.stringify({ bpm: seq.bpm, timeSig: seq.timeSig, kind, mapping: r.mapping }, null, 2)) },
    ...exportSlices(doc, audio, ids, s, names).map((f) => ({ ...f, name: `slices/${f.name}` })),
  ];
}
