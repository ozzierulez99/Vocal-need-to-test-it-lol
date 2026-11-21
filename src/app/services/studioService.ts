import type { Candidate, GeneratorSettings, ProjectDoc } from '../../core/types';
import { generate } from '../../core/compose/engine';
import { generateCandidates, generateVariations } from '../../core/compose/candidates';
import { scoreHook } from '../../core/compose/critic';
import { computeMetrics } from '../../core/compose/metrics';
import { detectVocalKey } from '../../core/compose/vocalKey';
import { swapChop, shuffleChops, transposeIdea } from '../../core/compose/ideaEdit';
import { keyName } from '../../core/beat/analyze';
import { ticksPerBar } from '../../core/time';
import { exportStems, exportMidiPackage } from '../../core/project/exporters';
import { safeName } from '../../core/midi/midi';
import { uid } from '../../core/ids';
import { useStore, actions } from '../store/store';
import { audition, stop } from '../transport';
import { applyCandidate, preparePads, effectiveSettings } from './composeService';
import { platform } from '../platform/platform';
import { STYLES, styleById, styleSettings, DEFAULT_TWEAKS, type StudioStyle, type StudioTweaks } from '../studio/styles';

/**
 * Studio: the quick, playful front end. Ideas are the unit of work – they are
 * generated across styles, explored within a style, edited in place (swap
 * chops, shuffle, pitch, swing) and dragged out, without touching the
 * arrangement used by the Pro editor.
 */
const st = () => useStore.getState();
const sleep = () => new Promise((r) => setTimeout(r, 0));

/* ───────────── which ideas are shown ───────────── */

export function ideasFor(tab: string, cands: Candidate[]): Candidate[] {
  const byId = new Map(cands.map((c) => [c.id, c]));
  const root = (c: Candidate) => {
    let r = c;
    for (let i = 0; i < 20 && r.parentId && byId.has(r.parentId); i++) r = byId.get(r.parentId)!;
    return r;
  };
  const list = cands.filter((c) => (tab === 'liked' ? c.favourite : tab === 'all' ? true : c.style === tab));
  // newest groups first; variations stay right after the idea they came from
  return list
    .map((c) => ({ c, r: root(c) }))
    .sort((a, b) => (b.r.batch ?? b.r.createdAt) - (a.r.batch ?? a.r.createdAt) || a.r.createdAt - b.r.createdAt || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0) || a.c.createdAt - b.c.createdAt)
    .map((x) => x.c);
}

export const visibleIdeas = () => ideasFor(st().ui.studioTab ?? 'all', st().doc.candidates);

/* ───────────── setup ───────────── */

function material(): string[] {
  const { doc, ui } = st();
  const v = ui.studioVocal;
  return v && v !== 'all' ? doc.slices.filter((s) => s.sourceId === v).map((s) => s.id) : [];
}

/** Key follows the vocal unless the user picked one (a loaded beat always wins inside the engine). */
export function ensureKey(): string | null {
  const { doc } = st();
  const s = doc.sequence.settings;
  if (doc.beat?.enabled) return null;
  if (s.keyAuto === false) return null;
  const ids = new Set(material());
  const k = detectVocalKey(ids.size ? doc.slices.filter((x) => ids.has(x.id)) : doc.slices, doc.sources);
  if (!k) return null;
  if (k.scale !== 'major') k.scale = 'minor';
  if (k.root !== s.keyRoot || k.scale !== s.scale) actions.setSettings({ keyRoot: k.root, scale: k.scale, keyAuto: true });
  return keyName(k.root, k.scale);
}

function base(): GeneratorSettings {
  return { ...effectiveSettings(), sliceIds: material(), materialKey: undefined };
}

function req() {
  const { doc } = st();
  const seq = doc.sequence;
  return { slices: doc.slices, sources: doc.sources, bpm: seq.bpm, timeSig: seq.timeSig, bars: seq.bars, beat: doc.beat?.enabled ? doc.beat : undefined };
}

/** One idea in a style: best of a few attempts according to the hook check. */
function makeIdea(style: StudioStyle, tweaks: StudioTweaks, seed: number, attempts = 3): Candidate {
  const r = req();
  let best: { out: ReturnType<typeof generate>; settings: GeneratorSettings; score: ReturnType<typeof scoreHook> } | null = null;
  for (let k = 0; k < attempts; k++) {
    const settings = { ...styleSettings(base(), style, tweaks), seed: (seed + k * 7919) >>> 0 };
    const out = generate({ ...r, settings });
    if (!out.events.length) continue;
    const score = scoreHook({ events: out.events, tracks: out.tracks, slices: r.slices, sources: r.sources, bpm: r.bpm, timeSig: r.timeSig, bars: r.bars, settings, beat: r.beat });
    if (!best || score.total > best.score.total) best = { out, settings, score };
  }
  if (!best) throw new Error('No usable chops for this style yet.');
  return {
    id: uid('idea'),
    label: style.label,
    style: style.id,
    profile: 'studio',
    settings: best.settings,
    tracks: best.out.tracks,
    events: best.out.events,
    motifs: best.out.motifs,
    metrics: computeMetrics(best.out.events, r.slices, r.sources, r.bpm, r.timeSig, r.bars),
    description: best.out.description,
    favourite: false,
    createdAt: Date.now(),
    groove: best.out.groove,
    score: best.score,
  };
}

let token = 0;
function begin(label: string) {
  const t = ++token;
  st().setUI({ studioBusy: label });
  return t;
}
function end(t: number) {
  if (t === token) st().setUI({ studioBusy: null });
}

function afterNew(first: Candidate | undefined) {
  if (!first) return;
  const wasPlaying = st().playing;
  st().setUI({ idea: first.id });
  if (wasPlaying) playIdea(first.id);
}

function check(): boolean {
  if (!st().doc.slices.length) {
    st().toast('Drop a vocal first – it gets chopped automatically', 'error');
    return false;
  }
  return true;
}

/** One idea in each style, added card by card. */
export async function generateMix() {
  if (!check()) return;
  const t = begin('Writing ideas across styles…');
  const k = ensureKey();
  preparePads({ ...base(), mode: 'ghost' });
  const seed0 = (Date.now() & 0xfffff) >>> 0;
  const batch = Date.now();
  let first: Candidate | undefined;
  let n = 0;
  for (const [i, style] of STYLES.filter((s) => s.inMix).entries()) {
    await sleep();
    if (t !== token) return;
    try {
      const c = makeIdea(style, DEFAULT_TWEAKS, seed0 + i * 977);
      c.batch = batch;
      c.createdAt = batch + i;
      actions.addCandidates([c]);
      n++;
      if (!first) {
        first = c;
        afterNew(c);
      }
    } catch {
      /* a style that cannot work with this material is skipped */
    }
  }
  end(t);
  st().toast(`${n} ideas in ${n} styles${k ? ` · key ${k} (from your vocal)` : ''} – click one to play, click a style to dive in`, 'success');
}

/** Dive into a style: six different takes on it (different emphasis, same style). */
export async function generateStyle(styleId: string, count = 6) {
  if (!check()) return;
  const style = styleById(styleId);
  if (!style) return;
  const t = begin(`Writing ${style.label} ideas…`);
  ensureKey();
  if (style.mode === 'ghost' || style.direction === 'ambient') preparePads({ ...base(), mode: 'ghost' });
  await sleep();
  if (t !== token) return;
  try {
    const tweaks = st().ui.studioTweaks ?? DEFAULT_TWEAKS;
    const settings = { ...styleSettings(base(), style, tweaks), seed: (Date.now() & 0xfffff) >>> 0 };
    const cands = generateCandidates({ ...req(), settings, count, attempts: 2 });
    const batch = Date.now();
    for (const [i, c] of cands.entries()) {
      c.batch = batch;
      c.createdAt = batch + i;
      c.style = style.id;
      c.label = `${style.label} · ${c.label.replace(/^Most /, '')}`;
    }
    actions.addCandidates(cands);
    afterNew(cands[0]);
  } catch (e) {
    st().toast((e as Error).message, 'error');
  }
  end(t);
}

/** Four variations of an idea, shown right after it. */
export async function moreLikeThis(id: string) {
  const c = st().doc.candidates.find((x) => x.id === id);
  if (!c) return;
  const t = begin('Making variations…');
  await sleep();
  try {
    const vars = generateVariations({ ...req(), settings: c.settings }, c, 4, Date.now() % 100000);
    const name = c.label.split(' ↻')[0];
    const now = Date.now();
    for (const [i, v] of vars.entries()) {
      v.createdAt = now + i;
      v.parentId = c.id;
      v.style = c.style;
      v.label = `${name} ↻ ${v.label.replace(/ variation$/i, '').toLowerCase()}`;
    }
    actions.addCandidates(vars);
    afterNew(vars[0]);
  } catch (e) {
    st().toast((e as Error).message, 'error');
  }
  end(t);
}

/** Random style, random tweaks: three ideas. */
export async function surprise() {
  if (!check()) return;
  const style = STYLES[Math.floor(Math.random() * STYLES.length)];
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  st().setUI({
    studioTab: style.id,
    studioTweaks: { purpose: pick(['hook', 'hook', 'drop', 'verse', 'build'] as const), energy: pick(['chill', 'mid', 'hype'] as const), register: pick(['low', 'mid', 'mid', 'high'] as const), half: pick(['auto', 'auto', 'half', 'normal'] as const) },
  });
  await generateStyle(style.id, 3);
}

/* ───────────── playing ───────────── */

export function playIdea(id: string) {
  const { doc } = st();
  const seq = doc.sequence;
  const full = seq.bars * ticksPerBar(seq.timeSig);
  if (!seq.loop.enabled || seq.loop.startTick !== 0 || seq.loop.endTick !== full)
    st().setPrefs((d) => void (d.sequence.loop = { enabled: true, startTick: 0, endTick: full }));
  st().setUI({ idea: id });
  audition(id);
}

export function toggleIdea(id: string) {
  const s = st();
  if (s.playing && s.ui.auditioning === id) stop();
  else playIdea(id);
}

/** ← / → through the visible ideas (seamless while playing). */
export function stepIdea(dir: 1 | -1) {
  const list = visibleIdeas();
  if (!list.length) return;
  const i = list.findIndex((c) => c.id === st().ui.idea);
  const next = list[(i + dir + list.length) % list.length] ?? list[0];
  if (st().playing) playIdea(next.id);
  else st().setUI({ idea: next.id });
}

/* ───────────── editing an idea (with its own undo) ───────────── */

type Snap = { id: string; events: Candidate['events']; tracks: Candidate['tracks']; groove: Candidate['groove']; label: string };
const history: Snap[] = [];

function editIdea(id: string, label: string, fn: (c: Candidate) => Partial<Candidate>) {
  const c = st().doc.candidates.find((x) => x.id === id);
  if (!c) return;
  history.push({ id, events: c.events, tracks: c.tracks, groove: c.groove, label });
  if (history.length > 100) history.shift();
  actions.updateCandidate(id, fn(c));
}

/** Undo the last idea edit; returns false when there is none (then the normal undo applies). */
export function undoIdeaEdit(): boolean {
  const h = history.pop();
  if (!h) return false;
  if (!st().doc.candidates.some((c) => c.id === h.id)) return undoIdeaEdit();
  actions.updateCandidate(h.id, { events: h.events, tracks: h.tracks, groove: h.groove });
  st().toast(`Undone: ${h.label}`, 'info');
  return true;
}

export function swapIdeaChop(id: string, fromSlice: string, toSlice: string) {
  const { doc } = st();
  editIdea(id, 'swap chop', (c) => ({ events: swapChop(c.events, fromSlice, toSlice, doc.slices, doc.sources) }));
}

export function shuffleIdea(id: string) {
  const { doc } = st();
  editIdea(id, 'shuffle chops', (c) => ({ events: shuffleChops(c.events, doc.slices, doc.sources, Date.now() & 0xffff) }));
}

export function transposeIdeaBy(id: string, semis: number) {
  editIdea(id, `pitch ${semis > 0 ? '+' : ''}${semis}`, (c) => ({ events: transposeIdea(c.events, semis) }));
}

export function setIdeaSwing(id: string, swing: number) {
  const c = st().doc.candidates.find((x) => x.id === id);
  if (!c) return;
  actions.updateCandidate(id, { groove: { swing, humanize: c.groove?.humanize ?? 0 } });
}

export function toggleLayer(id: string, trackId: string) {
  editIdea(id, 'mute layer', (c) => ({ tracks: c.tracks.map((t) => (t.id === trackId ? { ...t, mute: !t.mute } : t)) }));
}

export function toggleLike(id: string) {
  const c = st().doc.candidates.find((x) => x.id === id);
  if (c) actions.updateCandidate(id, { favourite: !c.favourite });
}

export function deleteIdea(id: string) {
  const list = visibleIdeas();
  const i = list.findIndex((c) => c.id === id);
  if (st().ui.auditioning === id) stop();
  actions.removeCandidate(id);
  const next = list[i + 1] ?? list[i - 1];
  st().setUI({ idea: next && next.id !== id ? next.id : null });
}

export function openInEditor(id: string) {
  const c = st().doc.candidates.find((x) => x.id === id);
  if (!c) return;
  stop();
  applyCandidate(c, 'all');
  st().setUI({ view: 'compose', auditioning: null });
}

/* ───────────── getting it out ───────────── */

function docWith(c: Candidate): ProjectDoc {
  const { doc } = st();
  return { ...doc, name: `${doc.name || 'vocal-chop'}_${c.label}`, sequence: { ...doc.sequence, tracks: c.tracks, events: c.events, motifs: c.motifs, groove: c.groove } };
}

export async function saveIdeaStems(id: string) {
  const c = st().doc.candidates.find((x) => x.id === id);
  if (!c) return;
  const files = exportStems(docWith(c), st().rt.audio, st().doc.exportSettings);
  const where = await platform.writeExport(files, safeName(`${c.label}_stems`));
  if (where) st().toast(`${files.length} stems saved`, 'success');
}

export async function saveIdeaMidi(id: string) {
  const c = st().doc.candidates.find((x) => x.id === id);
  if (!c) return;
  const files = exportMidiPackage(docWith(c), st().rt.audio, st().doc.exportSettings, 'trigger');
  const where = await platform.writeExport(files, safeName(`${c.label}_midi`));
  if (where) st().toast('MIDI + chop WAVs + mapping saved', 'success');
}
