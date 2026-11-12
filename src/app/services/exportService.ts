import type { AudioData, Candidate } from '../../core/types';
import { renderSequence } from '../../core/audio/render';
import { encodeWav } from '../../core/audio/wav';
import { safeName } from '../../core/midi/midi';
import { exportMixFile, type ExportFile, type MixOptions } from '../../core/project/exporters';
import type { RenderResult } from '../../core/audio/render';
import { printFx } from '../audio/fxPrint';
import { platform } from '../platform/platform';
import { useStore } from '../store/store';

const st = () => useStore.getState();

/** Applies the audition effects to rendered audio when "print effects" is on. */
export async function maybePrintFx(audio: AudioData): Promise<AudioData> {
  const { doc } = st();
  const fx = doc.fx;
  if (!fx?.print || (!fx.reverb && !fx.delay)) return audio;
  return printFx(audio, fx, doc.sequence.bpm);
}

/** Render an idea (or the arrangement with null) to a WAV with the current export settings. */
export async function renderIdeaFile(c: Candidate | null): Promise<ExportFile> {
  const { doc, rt } = st();
  const seq = doc.sequence;
  const es = doc.exportSettings;
  const target = c ? { events: c.events, tracks: c.tracks, bpm: seq.bpm, timeSig: seq.timeSig, bars: seq.bars, groove: c.groove ?? seq.groove } : seq;
  const r = renderSequence(target, doc.slices, doc.sources, rt.audio, { sampleRate: es.sampleRate, clickFadeMs: es.clickFadeMs, tail: es.tail, level: es.level, respectMuteSolo: true });
  const audio = await maybePrintFx(r.audio);
  const label = c ? c.label : 'arrangement';
  return { name: `${safeName(doc.name || 'vocal-chop')}_${safeName(label)}_${seq.bpm}bpm.wav`, bytes: encodeWav(audio, es.bitDepth) };
}

/* ───────────── drag to DAW ───────────── */

const prepared = new Map<string, { key: unknown; path: string }>();
const pending = new Map<string, Promise<string | null>>();
const keyOf = (c: Candidate | null) => (c ? c : st().doc.sequence);

/** Renders to a temp file ahead of the drag (called on hover / mouse-down of the drag handle). */
export function prepareDrag(c: Candidate | null): Promise<string | null> {
  if (!platform.dragOut) return Promise.resolve(null);
  const id = c?.id ?? '__arrangement';
  const hit = prepared.get(id);
  if (hit && hit.key === keyOf(c)) return Promise.resolve(hit.path);
  const running = pending.get(id);
  if (running) return running;
  const key = keyOf(c);
  const p = (async () => {
    try {
      const file = await renderIdeaFile(c);
      const path = await platform.dragOut!.prepare(file);
      prepared.set(id, { key, path });
      return path;
    } catch (e) {
      st().toast(`Could not prepare the drag: ${(e as Error).message}`, 'error');
      return null;
    } finally {
      pending.delete(id);
    }
  })();
  pending.set(id, p);
  return p;
}

/** dragstart handler: hands the prepared file to the OS. Returns false when it is not ready yet. */
export function startDrag(c: Candidate | null): boolean {
  if (!platform.dragOut) return false;
  const hit = prepared.get(c?.id ?? '__arrangement');
  if (!hit || hit.key !== keyOf(c)) {
    void prepareDrag(c);
    st().toast('Rendering… drag again in a moment', 'info');
    return false;
  }
  platform.dragOut.start(hit.path);
  return true;
}

export const canDragOut = () => !!platform.dragOut;

/** Save one idea straight to a WAV (no need to apply it first). */
export async function quickExport(c: Candidate | null) {
  try {
    const file = await renderIdeaFile(c);
    const where = await platform.saveFile(file);
    if (where) st().toast(`Saved ${file.name}`, 'success');
  } catch (e) {
    st().toast(`Export failed: ${(e as Error).message}`, 'error');
  }
}

/** Mix export that honours "print effects" (stems, slices and MIDI packages always stay dry). */
export async function mixFile(o: MixOptions = {}): Promise<ExportFile & { result: RenderResult }> {
  const { doc, rt } = st();
  const es = doc.exportSettings;
  const f = exportMixFile(doc, rt.audio, es, o);
  const fx = doc.fx;
  if (!fx?.print || (!fx.reverb && !fx.delay) || o.loopReady) return f;
  const wet = await printFx(f.result.audio, fx, doc.sequence.bpm);
  return { ...f, name: f.name.replace(/\.wav$/, '_fx.wav'), bytes: encodeWav(wet, es.bitDepth) };
}
