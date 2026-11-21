import type { AudioData, Candidate } from '../../core/types';
import { renderSequence } from '../../core/audio/render';
import { encodeWav } from '../../core/audio/wav';
import { safeName } from '../../core/midi/midi';
import { exportMixFile, exportSlices, type ExportFile, type MixOptions } from '../../core/project/exporters';
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

/**
 * Files are rendered ahead of the drag (on hover), because a drag must start
 * synchronously. Desktop: written to a temp folder and handed to the OS as a
 * real file drag. Browser build: a blob URL dragged with Chromium's
 * DownloadURL (drop onto the desktop / a folder).
 */
type Prepared = { key: unknown; name: string; path?: string; url?: string };
const prepared = new Map<string, Prepared>();
const pending = new Map<string, Promise<Prepared | null>>();
/** names of files we dragged out, so dropping one back onto the window is ignored */
export const draggedOutNames = new Set<string>();
let dragStartedAt = 0;
export const recentlyDraggedOut = () => Date.now() - dragStartedAt < 15000;

function prepareFile(id: string, key: unknown, make: () => Promise<ExportFile>): Promise<Prepared | null> {
  const hit = prepared.get(id);
  if (hit && hit.key === key) return Promise.resolve(hit);
  const running = pending.get(id);
  if (running) return running;
  const p = (async () => {
    try {
      const file = await make();
      const out: Prepared = { key, name: file.name };
      if (platform.dragOut) out.path = await platform.dragOut.prepare(file);
      else {
        if (hit?.url) URL.revokeObjectURL(hit.url);
        out.url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: 'audio/wav' }));
      }
      prepared.set(id, out);
      return out;
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

function beginDrag(id: string, key: unknown, e: { preventDefault(): void; dataTransfer: DataTransfer | null }, prepare: () => void): boolean {
  const hit = prepared.get(id);
  if (!hit || hit.key !== key) {
    e.preventDefault();
    prepare();
    st().toast('Rendering… drag again in a moment', 'info');
    return false;
  }
  dragStartedAt = Date.now();
  draggedOutNames.add(hit.name);
  if (platform.dragOut && hit.path) {
    e.preventDefault();
    platform.dragOut.start(hit.path);
  } else if (hit.url && e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('DownloadURL', `audio/wav:${hit.name}:${hit.url}`);
    e.dataTransfer.setData('text/plain', hit.name);
  }
  return true;
}

const keyOf = (c: Candidate | null) => (c ? c : st().doc.sequence);
const ideaKey = (c: Candidate | null) => [keyOf(c), st().doc.fx?.print ? st().doc.fx : null, st().doc.exportSettings];
const ideaCache = new Map<string, unknown[]>();
function stableIdeaKey(c: Candidate | null) {
  const id = c?.id ?? '__arrangement';
  const k = ideaKey(c);
  const prev = ideaCache.get(id);
  if (prev && prev.length === k.length && prev.every((x, i) => x === k[i])) return prev;
  ideaCache.set(id, k);
  return k;
}

/** Renders an idea (or the arrangement with null) for dragging. Call on hover. */
export function prepareDrag(c: Candidate | null): Promise<string | null> {
  return prepareFile(c?.id ?? '__arrangement', stableIdeaKey(c), () => renderIdeaFile(c)).then((p) => p?.path ?? p?.url ?? null);
}

/** Desktop-only drag start used by the Pro views (they call preventDefault themselves). */
export function startDrag(c: Candidate | null): boolean {
  const hit = prepared.get(c?.id ?? '__arrangement');
  if (!platform.dragOut || !hit?.path || hit.key !== stableIdeaKey(c)) {
    void prepareDrag(c);
    st().toast('Rendering… drag again in a moment', 'info');
    return false;
  }
  dragStartedAt = Date.now();
  draggedOutNames.add(hit.name);
  platform.dragOut.start(hit.path);
  return true;
}

/** onDragStart for an idea card: works in the desktop app and the browser build. */
export function dragIdea(c: Candidate, e: { preventDefault(): void; dataTransfer: DataTransfer | null }) {
  return beginDrag(c.id, stableIdeaKey(c), e, () => void prepareDrag(c));
}

function sliceFile(sliceId: string): Promise<ExportFile> {
  const { doc, rt } = st();
  const files = exportSlices(doc, rt.audio, [sliceId], doc.exportSettings);
  if (!files.length) return Promise.reject(new Error('chop audio is missing'));
  const sl = doc.slices.find((x) => x.id === sliceId)!;
  return Promise.resolve({ ...files[0], name: `${safeName(doc.name || 'vocal-chop')}_chop_${safeName(sl.name)}.wav` });
}
const sliceKey = (id: string) => st().doc.slices.find((x) => x.id === id);

export function prepareSliceDrag(sliceId: string) {
  return prepareFile(`slice:${sliceId}`, sliceKey(sliceId), () => sliceFile(sliceId));
}
export function dragSlice(sliceId: string, e: { preventDefault(): void; dataTransfer: DataTransfer | null }) {
  return beginDrag(`slice:${sliceId}`, sliceKey(sliceId), e, () => void prepareSliceDrag(sliceId));
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
