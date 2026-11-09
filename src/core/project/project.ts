import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { AudioData, ProjectDoc, Sequence, ExportSettings } from '../types';
import { defaultSettings } from '../compose/engine';

/**
 * Project format
 * ──────────────
 *   MyIdea.vcs/
 *     project.json      ← all state (sources, slices, sequence, candidates, settings) – no audio
 *     audio/<asset>     ← managed copies of imported files / recordings (never modified)
 *
 * The same structure zipped is a portable single-file bundle (.vcsz).
 * Paths inside project.json are relative so a project folder can be moved or shared.
 */
export const PROJECT_VERSION = 1;
export const PROJECT_FILE = 'project.json';
export const AUDIO_DIR = 'audio';

export interface ProjectFS {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

export const join = (...p: string[]) => p.filter(Boolean).join('/').replace(/\/+/g, '/');

export function defaultExportSettings(): ExportSettings {
  return { sampleRate: 44100, bitDepth: 24, level: 'prevent-clip', clickFadeMs: 3, tail: 'keep' };
}

export function emptySequence(): Sequence {
  return {
    id: 'seq-main',
    name: 'Arrangement',
    bpm: 140,
    timeSig: [4, 4],
    bars: 8,
    tracks: [
      { id: 'trk-lead', name: 'Lead hook', role: 'lead', mute: false, solo: false, gain: 0, pan: 0, locked: false, color: '#ff6fa8' },
    ],
    events: [],
    motifs: [],
    lockedBars: [],
    lockedRests: [],
    loop: { enabled: true, startTick: 0, endTick: 8 * 3840 },
    grid: 240,
    snap: true,
    settings: defaultSettings(),
  };
}

export function newProjectDoc(name = 'Untitled idea'): ProjectDoc {
  return {
    version: PROJECT_VERSION,
    name,
    sources: [],
    slices: [],
    sequence: emptySequence(),
    collections: [],
    candidates: [],
    exportSettings: defaultExportSettings(),
    clickFadeMs: 3,
    midiGuides: [],
  };
}

export class ProjectFormatError extends Error {}

/** Parse + validate + migrate project JSON, filling defaults for missing fields. */
export function parseProject(text: string): ProjectDoc {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('project.json is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sources) || !Array.isArray(raw.slices) || !raw.sequence)
    throw new ProjectFormatError('This does not look like a Vocal Chop Studio project.');
  if ((raw.version ?? 1) > PROJECT_VERSION) throw new ProjectFormatError(`Project was saved by a newer version (format ${raw.version}).`);
  const base = newProjectDoc(raw.name ?? 'Untitled idea');
  const seq = { ...emptySequence(), ...raw.sequence };
  seq.settings = { ...defaultSettings(), ...(raw.sequence.settings ?? {}), controls: { ...defaultSettings().controls, ...(raw.sequence.settings?.controls ?? {}) } };
  seq.events = (seq.events ?? []).map((e: any) => ({ offset: 0, gain: 0, semitones: 0, reverse: false, fadeIn: 0, fadeOut: 0, pan: 0, velocity: 0.8, locked: false, ...e }));
  seq.tracks = (seq.tracks ?? []).map((t: any) => ({ mute: false, solo: false, gain: 0, pan: 0, locked: false, color: '#ff6fa8', role: 'lead', ...t }));
  return {
    ...base,
    ...raw,
    version: PROJECT_VERSION,
    sources: raw.sources.map((s: any) => ({ ...s, missing: false })),
    slices: raw.slices.map((s: any) => ({ tags: [], favourite: false, ...s })),
    sequence: seq,
    collections: raw.collections ?? [],
    candidates: raw.candidates ?? [],
    exportSettings: { ...defaultExportSettings(), ...(raw.exportSettings ?? {}) },
    midiGuides: raw.midiGuides ?? [],
  };
}

export function serializeProject(doc: ProjectDoc): string {
  // missing flags are runtime state, not persisted
  const clean = { ...doc, sources: doc.sources.map(({ missing, ...s }) => s) };
  return JSON.stringify(clean, null, 1);
}

export async function saveProject(fs: ProjectFS, dir: string, doc: ProjectDoc, assets: Map<string, Uint8Array>): Promise<{ written: string[] }> {
  await fs.mkdir(dir);
  await fs.mkdir(join(dir, AUDIO_DIR));
  const written: string[] = [];
  for (const src of doc.sources) {
    const path = join(dir, AUDIO_DIR, src.assetName);
    const bytes = assets.get(src.assetName);
    if (!bytes) continue; // missing source: keep the reference, nothing to write
    if (!(await fs.exists(path))) {
      await fs.writeBytes(path, bytes);
      written.push(path);
    }
  }
  await fs.writeText(join(dir, PROJECT_FILE), serializeProject(doc));
  written.push(join(dir, PROJECT_FILE));
  return { written };
}

export interface LoadedProject {
  doc: ProjectDoc;
  assets: Map<string, Uint8Array>;
  audio: Map<string, AudioData>;
  missing: string[];
  errors: string[];
}

/**
 * Load a project. Sources whose asset is missing or undecodable are flagged
 * `missing` (their slices stay defined and can be re-linked later).
 */
export async function loadProject(
  fs: ProjectFS,
  dir: string,
  decode: (bytes: Uint8Array, name: string) => Promise<AudioData>,
): Promise<LoadedProject> {
  const doc = parseProject(await fs.readText(join(dir, PROJECT_FILE)));
  const assets = new Map<string, Uint8Array>();
  const audio = new Map<string, AudioData>();
  const missing: string[] = [];
  const errors: string[] = [];
  for (const src of doc.sources) {
    const path = join(dir, AUDIO_DIR, src.assetName);
    try {
      if (!(await fs.exists(path))) {
        src.missing = true;
        missing.push(src.name);
        continue;
      }
      const bytes = await fs.readBytes(path);
      assets.set(src.assetName, bytes);
      audio.set(src.id, await decode(bytes, src.assetName));
    } catch (e) {
      src.missing = true;
      missing.push(src.name);
      errors.push(`${src.name}: ${(e as Error).message}`);
    }
  }
  return { doc, assets, audio, missing, errors };
}

/** Single-file portable bundle (zip of project.json + audio/). */
export function bundleProject(doc: ProjectDoc, assets: Map<string, Uint8Array>): Uint8Array {
  const files: Record<string, Uint8Array> = { [PROJECT_FILE]: strToU8(serializeProject(doc)) };
  for (const s of doc.sources) {
    const b = assets.get(s.assetName);
    if (b) files[`${AUDIO_DIR}/${s.assetName}`] = [b, { level: 0 }] as any;
  }
  return zipSync(files as any);
}

export function unbundleProject(zip: Uint8Array): { doc: ProjectDoc; assets: Map<string, Uint8Array> } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new ProjectFormatError('Not a valid project bundle.');
  }
  const pj = files[PROJECT_FILE];
  if (!pj) throw new ProjectFormatError('Bundle has no project.json.');
  const doc = parseProject(strFromU8(pj));
  const assets = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) if (k.startsWith(`${AUDIO_DIR}/`)) assets.set(k.slice(AUDIO_DIR.length + 1), v);
  for (const s of doc.sources) if (!assets.has(s.assetName)) s.missing = true;
  return { doc, assets };
}

/** In-memory ProjectFS (tests, browser fallback building block). */
export class MemoryFS implements ProjectFS {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();
  async readText(p: string) {
    return strFromU8(await this.readBytes(p));
  }
  async readBytes(p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error(`File not found: ${p}`);
    return f;
  }
  async writeText(p: string, t: string) {
    this.files.set(p, strToU8(t));
  }
  async writeBytes(p: string, b: Uint8Array) {
    this.files.set(p, b);
  }
  async exists(p: string) {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(p: string) {
    this.dirs.add(p);
  }
}
