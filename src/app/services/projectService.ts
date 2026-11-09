import type { AudioData, ProjectDoc, SourceAudio } from '../../core/types';
import { newProjectDoc, saveProject, loadProject, bundleProject, unbundleProject } from '../../core/project/project';
import { encodeWav, frameCount } from '../../core/audio/wav';
import { autoChop } from '../../core/slicing/slices';
import { parseMidi, guideFromMidi } from '../../core/midi/midi';
import { EXAMPLES, demoSource } from '../../core/demo/examples';
import { DEMO_VOICES } from '../../core/demo/synthVoice';
import { uid } from '../../core/ids';
import { useStore, actions } from '../store/store';
import { platform, decodeAudio, type PickedFile } from '../platform/platform';
import { engine } from '../audio/engine';

const st = () => useStore.getState();

function syncEngine() {
  for (const [id, a] of st().rt.audio) engine.setAudio(id, a);
}

export function newProject() {
  engine.stop();
  st().loadDoc(newProjectDoc(), new Map(), new Map(), null);
  st().setUI({ view: 'slice' });
}

export async function saveCurrent(saveAs = false): Promise<boolean> {
  const { doc, location, rt } = st();
  let loc = location;
  if (!loc || saveAs || loc.startsWith('bundle:') || loc.startsWith('example:')) {
    loc = await platform.chooseProjectLocation(doc.name || 'Untitled idea');
    if (!loc) return false;
  }
  try {
    await saveProject(platform.fs, loc, doc, rt.assets);
    await platform.addRecent({ name: doc.name, location: loc });
    st().markSaved(loc);
    st().toast(`Saved “${doc.name}”`, 'success');
    return true;
  } catch (e) {
    st().toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
}

async function decodeAssets(doc: ProjectDoc, assets: Map<string, Uint8Array>) {
  const audio = new Map<string, AudioData>();
  const missing: string[] = [];
  for (const s of doc.sources) {
    const b = assets.get(s.assetName);
    if (!b) {
      s.missing = true;
      missing.push(s.name);
      continue;
    }
    try {
      audio.set(s.id, await decodeAudio(b, s.assetName));
    } catch {
      s.missing = true;
      missing.push(s.name);
    }
  }
  return { audio, missing };
}

export async function openProject(location?: string | null) {
  const loc = location ?? (await platform.pickProject());
  if (!loc) return;
  engine.stop();
  try {
    if (await platform.isBundle(loc)) {
      const bytes = await platform.fs.readBytes(loc.replace(/^bundle:/, ''));
      return importBundleBytes(bytes);
    }
    const r = await loadProject(platform.fs, loc, decodeAudio);
    st().loadDoc(r.doc, r.audio, r.assets, loc);
    syncEngine();
    await platform.addRecent({ name: r.doc.name, location: loc });
    if (r.missing.length) st().toast(`Missing audio: ${r.missing.join(', ')}. Use “Relink” on the source to locate it.`, 'error');
    else st().toast(`Opened “${r.doc.name}”`, 'success');
    st().setUI({ view: r.doc.sequence.events.length ? 'compose' : 'slice' });
  } catch (e) {
    st().toast(`Could not open project: ${(e as Error).message}`, 'error');
  }
}

export async function exportBundle() {
  const { doc, rt } = st();
  const bytes = bundleProject(doc, rt.assets);
  const p = await platform.saveFile({ name: `${doc.name || 'project'}.vcsz`, bytes });
  if (p) st().toast(`Bundle written: ${p}`, 'success');
}

export async function importBundleBytes(bytes: Uint8Array) {
  try {
    const { doc, assets } = unbundleProject(bytes);
    const { audio, missing } = await decodeAssets(doc, assets);
    st().loadDoc(doc, audio, assets, null);
    syncEngine();
    st().toast(missing.length ? `Bundle opened; missing: ${missing.join(', ')}` : `Opened bundle “${doc.name}”`, missing.length ? 'error' : 'success');
    st().setUI({ view: doc.sequence.events.length ? 'compose' : 'slice' });
  } catch (e) {
    st().toast((e as Error).message, 'error');
  }
}

export function loadExample(key: string) {
  const ex = EXAMPLES[key];
  if (!ex) return;
  engine.stop();
  const p = ex.build();
  st().loadDoc(p.doc, p.audio, p.assets, `example:${key}`);
  syncEngine();
  st().setUI({ view: 'compose' });
  st().toast(`Example loaded: ${ex.title}`, 'success');
}

function extOf(name: string) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : 'bin';
}

export function addDecodedSource(name: string, audio: AudioData, bytes: Uint8Array, kind: SourceAudio['kind'], ext: string, originalPath?: string): SourceAudio {
  const id = uid('src');
  const src: SourceAudio = {
    id,
    name: name.replace(/\.[^.]+$/, ''),
    assetName: `${id}.${ext}`,
    originalPath,
    kind,
    sampleRate: audio.sampleRate,
    channelCount: audio.channels.length,
    frames: frameCount(audio),
    createdAt: Date.now(),
  };
  st().addSource(src, audio, bytes);
  engine.setAudio(id, audio);
  return src;
}

export async function importAudioFiles(files: PickedFile[], autoSlice = true) {
  let n = 0;
  for (const f of files) {
    try {
      const audio = await decodeAudio(f.bytes, f.name);
      if (frameCount(audio) < 64) throw new Error('file is empty');
      const src = addDecodedSource(f.name, audio, f.bytes, 'import', extOf(f.name), f.path);
      if (autoSlice) actions.addSlices(autoChop(src, audio, {}).slices, false);
      n++;
    } catch (e) {
      st().toast(`Could not import “${f.name}”: ${(e as Error).message}`, 'error');
    }
  }
  if (n) st().toast(`Imported ${n} recording${n > 1 ? 's' : ''}${autoSlice ? ' and suggested slices (phrase / word / syllable)' : ''}`, 'success');
}

export async function pickAndImportAudio() {
  const files = await platform.pickAudio();
  if (files.length) await importAudioFiles(files);
}

export function addDemoVoice(key: string) {
  const d = demoSource(key, uid('src'));
  d.src.assetName = `${d.src.id}.wav`;
  st().addSource(d.src, d.audio, d.bytes);
  engine.setAudio(d.src.id, d.audio);
  actions.addSlices(autoChop(d.src, d.audio, {}).slices, false);
  st().toast(`Added demo vocal: ${DEMO_VOICES[key].title}`, 'success');
}

export function keepRecording(audio: AudioData, name: string) {
  const bytes = encodeWav(audio, 24);
  const src = addDecodedSource(name, audio, bytes, 'recording', 'wav');
  actions.addSlices(autoChop(src, audio, {}).slices, false);
  st().toast(`Recording “${name}” kept and auto-sliced`, 'success');
}

export async function relinkSource(id: string) {
  const s = st().doc.sources.find((x) => x.id === id);
  if (!s) return;
  const f = await platform.pickRelink(s.name);
  if (!f) return;
  try {
    const audio = await decodeAudio(f.bytes, f.name);
    const asset = `${s.id}.${extOf(f.name)}`;
    st().relinkSource(id, audio, f.bytes, asset);
    engine.setAudio(id, audio);
    if (frameCount(audio) < s.frames) st().toast('Relinked file is shorter than the original – some slices may be cut.', 'error');
    else st().toast(`Relinked “${s.name}”`, 'success');
  } catch (e) {
    st().toast((e as Error).message, 'error');
  }
}

export async function importMidi() {
  const f = await platform.pickMidi();
  if (!f) return null;
  return importMidiBytes(f.bytes, f.name);
}

export function importMidiBytes(bytes: Uint8Array, name: string) {
  try {
    const parsed = parseMidi(bytes, name.replace(/\.midi?$/i, ''));
    const guide = guideFromMidi(parsed);
    st().commit('Import MIDI', (d) => {
      d.midiGuides.push(guide);
    });
    actions.setSettings({ mode: 'midi', midi: guide });
    st().toast(`MIDI “${guide.name}”: ${guide.notes.length} notes${parsed.bpm ? ` at ${Math.round(parsed.bpm)} BPM` : ''}`, 'success');
    return guide;
  } catch (e) {
    st().toast((e as Error).message, 'error');
    return null;
  }
}
