import { zipSync } from 'fflate';
import type { AudioData } from '../../core/types';
import { decodeWav, isWav, AudioFormatError } from '../../core/audio/wav';
import type { ProjectFS } from '../../core/project/project';
import type { ExportFile } from '../../core/project/exporters';

/**
 * Platform abstraction. In the desktop app (Electron) projects are folders on
 * disk and exports are written to a chosen folder. When the renderer runs in a
 * plain browser (development / automated UI tests) projects live in IndexedDB
 * and exports are downloaded. Everything else is identical.
 */
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  path?: string;
}

export interface Recent {
  name: string;
  location: string;
  savedAt?: number;
}

export interface Platform {
  kind: 'electron' | 'browser';
  fs: ProjectFS;
  pickAudio(): Promise<PickedFile[]>;
  pickMidi(): Promise<PickedFile | null>;
  pickRelink(name: string): Promise<PickedFile | null>;
  /** Returns a location for a new project folder, or null if cancelled. */
  chooseProjectLocation(name: string): Promise<string | null>;
  /** Ask the user for an existing project (folder or bundle). */
  pickProject(): Promise<string | null>;
  isBundle(location: string): Promise<boolean>;
  writeExport(files: ExportFile[], label: string): Promise<string | null>;
  saveFile(file: ExportFile): Promise<string | null>;
  recent(): Promise<Recent[]>;
  addRecent(r: Recent): Promise<void>;
  examples(): Promise<Recent[]>;
  reveal?(path: string): void;
  /** Native "drag this file out of the app" (desktop only): prepare writes a temp file, start begins the OS drag. */
  dragOut?: { prepare(file: ExportFile): Promise<string>; start(path: string): void };
}

declare global {
  interface Window {
    vcs?: { platform: string; invoke: (ch: string, ...a: unknown[]) => Promise<any>; onBeforeClose: (fn: () => void) => void; startDrag?: (file: string) => void };
  }
}

/* ───────────── decoding ───────────── */

let decodeCtx: AudioContext | null = null;

/** Decode any supported file: WAV natively (exact sample rate), others through Chromium's decoders. */
export async function decodeAudio(bytes: Uint8Array, name: string): Promise<AudioData> {
  if (isWav(bytes)) return decodeWav(bytes);
  decodeCtx = decodeCtx ?? new AudioContext();
  try {
    const buf = await decodeCtx.decodeAudioData(bytes.slice().buffer);
    const channels: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
    return { sampleRate: buf.sampleRate, channels };
  } catch {
    throw new AudioFormatError(`“${name}” could not be decoded. Supported: WAV (any PCM/float), and MP3, FLAC, OGG, M4A/AAC where the runtime supports them.`);
  }
}

/* ───────────── Electron ───────────── */

function electronPlatform(): Platform {
  const inv = window.vcs!.invoke;
  const fs: ProjectFS = {
    readText: (p) => inv('fs:readText', p),
    readBytes: async (p) => new Uint8Array(await inv('fs:readBytes', p)),
    writeText: (p, t) => inv('fs:writeText', p, t),
    writeBytes: (p, b) => inv('fs:writeBytes', p, b),
    exists: (p) => inv('fs:exists', p),
    mkdir: (p) => inv('fs:mkdir', p),
  };
  const toPicked = (f: any): PickedFile => ({ name: f.name, path: f.path, bytes: new Uint8Array(f.bytes) });
  return {
    kind: 'electron',
    fs,
    pickAudio: async () => ((await inv('dialog:openAudio')) as any[]).map(toPicked),
    pickMidi: async () => {
      const f = await inv('dialog:openMidi');
      return f ? toPicked(f) : null;
    },
    pickRelink: async (name) => {
      const f = await inv('dialog:relink', name);
      return f ? toPicked(f) : null;
    },
    chooseProjectLocation: (name) => inv('dialog:saveProject', name),
    pickProject: () => inv('dialog:openProject'),
    isBundle: (loc) => inv('fs:isFile', loc),
    writeExport: async (files, label) => {
      const dir = await inv('dialog:exportDir', label);
      if (!dir) return null;
      for (const f of files) await inv('fs:writeBytes', `${dir}/${f.name}`, f.bytes);
      return dir;
    },
    saveFile: async (file) => {
      const p = await inv('dialog:saveFile', file.name);
      if (!p) return null;
      await inv('fs:writeBytes', p, file.bytes);
      return p;
    },
    recent: () => inv('app:recent'),
    addRecent: (r) => inv('app:addRecent', r),
    examples: () => inv('app:examples'),
    reveal: (p) => void inv('shell:show', p),
    dragOut: window.vcs!.startDrag
      ? { prepare: (file) => inv('drag:prepare', file.name, file.bytes), start: (p) => window.vcs!.startDrag!(p) }
      : undefined,
  };
}

/* ───────────── Browser (IndexedDB) ───────────── */

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('vocal-chop-studio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function pickViaInput(accept: string, multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.dataset.testid = 'file-input';
    document.body.appendChild(input);
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const out = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      input.remove();
      resolve(out);
    };
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

export function download(name: string, bytes: Uint8Array, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function browserPlatform(): Platform {
  const fs: ProjectFS = {
    readText: async (p) => {
      const v = await idbOp<Uint8Array | undefined>('readonly', (s) => s.get(p) as IDBRequest<Uint8Array | undefined>);
      if (!v) throw new Error(`File not found: ${p}`);
      return dec.decode(v);
    },
    readBytes: async (p) => {
      const v = await idbOp<Uint8Array | undefined>('readonly', (s) => s.get(p) as IDBRequest<Uint8Array | undefined>);
      if (!v) throw new Error(`File not found: ${p}`);
      return v;
    },
    writeText: async (p, t) => void (await idbOp('readwrite', (s) => s.put(enc.encode(t), p))),
    writeBytes: async (p, b) => void (await idbOp('readwrite', (s) => s.put(b, p))),
    exists: async (p) => (await idbOp<number>('readonly', (s) => s.count(p))) > 0 || (await idbOp<number>('readonly', (s) => s.count(`${p}/.dir`))) > 0,
    mkdir: async (p) => void (await idbOp('readwrite', (s) => s.put(new Uint8Array(0), `${p}/.dir`))),
  };
  let pendingPick: ((v: string | null) => void) | null = null;
  return {
    kind: 'browser',
    fs,
    pickAudio: () => pickViaInput('audio/*,.wav,.mp3,.flac,.ogg,.m4a', true),
    pickMidi: async () => (await pickViaInput('.mid,.midi,audio/midi', false))[0] ?? null,
    pickRelink: async () => (await pickViaInput('audio/*,.wav,.mp3,.flac,.ogg,.m4a', false))[0] ?? null,
    chooseProjectLocation: async (name) => `idb/projects/${name.replace(/[^\w\- ]+/g, '_')}.vcs`,
    pickProject: () =>
      new Promise((res) => {
        pendingPick = res;
        window.dispatchEvent(new CustomEvent('vcs:pick-project', { detail: (loc: string | null) => { pendingPick = null; res(loc); } }));
        void pendingPick;
      }),
    isBundle: async (loc) => loc.startsWith('bundle:'),
    writeExport: async (files, label) => {
      if (files.length === 1) {
        download(files[0].name, files[0].bytes);
        return files[0].name;
      }
      const z: Record<string, Uint8Array> = {};
      for (const f of files) z[f.name] = f.bytes;
      const name = `${label}.zip`;
      download(name, zipSync(z, { level: 0 }), 'application/zip');
      return name;
    },
    saveFile: async (f) => {
      download(f.name, f.bytes);
      return f.name;
    },
    recent: async () => {
      try {
        return JSON.parse(await fs.readText('meta/recent.json'));
      } catch {
        return [];
      }
    },
    addRecent: async (r) => {
      let list: Recent[] = [];
      try {
        list = JSON.parse(await fs.readText('meta/recent.json'));
      } catch {
        /* none */
      }
      list = [{ ...r, savedAt: Date.now() }, ...list.filter((x) => x.location !== r.location)].slice(0, 20);
      await fs.writeText('meta/recent.json', JSON.stringify(list));
    },
    examples: async () => [],
  };
}

export const platform: Platform = typeof window !== 'undefined' && window.vcs ? electronPlatform() : browserPlatform();
