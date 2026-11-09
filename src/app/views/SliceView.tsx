import React, { useEffect, useMemo, useState } from 'react';
import { useStore, actions, analysisFor } from '../store/store';
import type { Slice, SliceLevel, SliceCategory, Role } from '../../core/types';
import { SLICE_LEVELS, SLICE_CATEGORIES, ROLES } from '../../core/types';
import { Waveform, type Region } from '../components/Waveform';
import { Btn, Section, Select, NumberField, TextField, Toggle, Empty, Slider } from '../components/ui';
import { makeSlice, splitSlice, mergeSlices, subdivide, suggestBoundaries, slicesFromBoundaries, autoChop, CHILD_LEVEL, LEVEL_PREFIX, type SuggestMethod, detectSoundRegionsFor } from '../../core/slicing/slices';
import { midiToName, nameToMidi } from '../../core/time';
import { auditionRegion, auditionSlice } from '../transport';
import { engine } from '../audio/engine';
import { pickAndImportAudio, addDemoVoice, relinkSource } from '../services/projectService';
import { DEMO_VOICES } from '../../core/demo/synthVoice';
import { uid } from '../../core/ids';

function fmtDur(frames: number, sr: number) {
  const s = frames / sr;
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`;
}

function SourcesPanel() {
  const sources = useStore((s) => s.doc.sources);
  const sourceId = useStore((s) => s.ui.sourceId);
  const setUI = useStore((s) => s.setUI);
  const slices = useStore((s) => s.doc.slices);
  const src = sources.find((s) => s.id === sourceId);
  const [demo, setDemo] = useState('sung-phrase');
  return (
    <aside className="panel">
      <Section title="Vocal sources">
        <div className="row tight">
          <Btn kind="primary" testid="import-audio" onClick={() => pickAndImportAudio()}>＋ Import audio</Btn>
          <Btn testid="open-recorder" onClick={() => setUI({ showRecorder: true })}>● Record</Btn>
        </div>
        <div className="row tight">
          <Select value={demo} options={Object.entries(DEMO_VOICES).map(([k, v]) => ({ value: k, label: v.title }))} onChange={setDemo} testid="demo-select" />
          <Btn small testid="add-demo" onClick={() => addDemoVoice(demo)} title="Adds a synthetic vocal-like recording">Add demo</Btn>
        </div>
        {!sources.length && <Empty>Import a vocal recording (WAV, MP3, FLAC…), record your voice, or add a synthetic demo vocal.</Empty>}
        <div className="col" style={{ gap: 4 }} data-testid="source-list">
          {sources.map((s) => (
            <div key={s.id} className={`source-item ${s.id === sourceId ? 'on' : ''} ${s.missing ? 'missing' : ''}`} onClick={() => setUI({ sourceId: s.id, sliceIds: [] })}>
              <span className="name">{s.kind === 'recording' ? '● ' : ''}{s.name}</span>
              <span className="meta">
                {fmtDur(s.frames, s.sampleRate)} · {s.sampleRate / 1000}k · {s.channelCount === 1 ? 'mono' : `${s.channelCount}ch`} · {slices.filter((x) => x.sourceId === s.id).length} slices
              </span>
              {s.missing && (
                <Btn small kind="danger" onClick={(e) => { e.stopPropagation(); void relinkSource(s.id); }}>Missing – relink…</Btn>
              )}
            </div>
          ))}
        </div>
      </Section>
      {src && (
        <Section title="Source info">
          <TextField label="Name" value={src.name} onChange={(v) => actions.updateSource(src.id, { name: v })} testid="source-name" />
          <dl className="info-grid">
            <dt>Duration</dt><dd>{fmtDur(src.frames, src.sampleRate)} ({src.frames} frames)</dd>
            <dt>Sample rate</dt><dd>{src.sampleRate} Hz</dd>
            <dt>Channels</dt><dd>{src.channelCount}</dd>
            <dt>Kind</dt><dd>{src.kind}</dd>
            <dt>Asset</dt><dd title={src.originalPath}>{src.assetName}</dd>
          </dl>
          <div className="row">
            <NumberField label="BPM (optional)" value={src.bpm ?? 0} min={0} max={300} onChange={(v) => actions.updateSource(src.id, { bpm: v || undefined })} />
            <TextField label="Root note" value={src.rootNote !== undefined ? midiToName(src.rootNote) : ''} placeholder="e.g. A3" onChange={(v) => actions.updateSource(src.id, { rootNote: nameToMidi(v) ?? undefined })} />
          </div>
          <TextField label="Key (optional)" value={src.key ?? ''} placeholder="e.g. A minor" onChange={(v) => actions.updateSource(src.id, { key: v || undefined })} />
          <Btn small kind="danger" onClick={() => window.confirm(`Remove “${src.name}” and its slices from the project?`) && actions.removeSource(src.id)}>Remove source</Btn>
        </Section>
      )}
    </aside>
  );
}

function SliceInspector({ slices }: { slices: Slice[] }) {
  const sources = useStore((s) => s.doc.sources);
  if (!slices.length)
    return (
      <Section title="Slice">
        <Empty>Click a slice in the lanes to inspect it. Slices are non-destructive references into the source.</Empty>
      </Section>
    );
  if (slices.length > 1) {
    const ids = slices.map((s) => s.id);
    return (
      <Section title={`${slices.length} slices`}>
        <Select label="Set category" value={'' as any} options={[{ value: '', label: '—' }, ...SLICE_CATEGORIES.map((c) => ({ value: c, label: c }))] as any} onChange={(v: any) => v && useStore.getState().commit('Set category', (d) => d.slices.forEach((s) => ids.includes(s.id) && (s.category = v)))} />
        <Select label="Set role tendency" value={'' as any} options={[{ value: '', label: '—' }, ...ROLES.map((c) => ({ value: c, label: c }))] as any} onChange={(v: any) => v && useStore.getState().commit('Set role', (d) => d.slices.forEach((s) => ids.includes(s.id) && (s.role = v)))} />
        <Btn small onClick={() => useStore.getState().commit('Favourite', (d) => d.slices.forEach((s) => ids.includes(s.id) && (s.favourite = true)))}>★ Favourite all</Btn>
      </Section>
    );
  }
  const s = slices[0];
  const src = sources.find((x) => x.id === s.sourceId)!;
  const a = s.analysis;
  const upd = (patch: Partial<Slice>, label?: string) => actions.updateSlice(s.id, patch, label);
  return (
    <Section title="Slice" right={<button className={`star ${s.favourite ? 'on' : ''}`} data-testid="slice-fav" onClick={() => upd({ favourite: !s.favourite }, 'Favourite')}>★</button>}>
      <TextField label="Name" value={s.name} onChange={(v) => upd({ name: v }, 'Rename slice')} testid="slice-name" />
      <div className="row">
        <Select label="Level" value={s.level} options={SLICE_LEVELS.map((l) => ({ value: l, label: l }))} onChange={(v) => upd({ level: v as SliceLevel })} />
        <Select label="Category" testid="slice-category" value={s.category ?? 'other'} options={SLICE_CATEGORIES.map((c) => ({ value: c, label: c }))} onChange={(v) => upd({ category: v as SliceCategory })} />
      </div>
      <div className="row">
        <Select label="Role tendency" value={s.role ?? ''} options={[{ value: '', label: 'any' }, ...ROLES.map((r) => ({ value: r, label: r }))]} onChange={(v) => upd({ role: (v || undefined) as Role | undefined })} />
        <TextField label="Root note" value={s.rootNote !== undefined ? midiToName(s.rootNote) : ''} placeholder={a?.pitch != null ? `≈${midiToName(a.pitch)}` : 'e.g. C4'} onChange={(v) => upd({ rootNote: nameToMidi(v) ?? undefined })} />
      </div>
      <TextField label="Tags (comma separated)" value={s.tags.join(', ')} onChange={(v) => upd({ tags: v.split(',').map((t) => t.trim()).filter(Boolean) })} testid="slice-tags" />
      <label className="field">
        <span>Notes</span>
        <textarea rows={2} value={s.notes ?? ''} onChange={(e) => upd({ notes: e.target.value })} onKeyDown={(e) => !e.ctrlKey && !e.metaKey && e.stopPropagation()} />
      </label>
      <dl className="info-grid">
        <dt>Position</dt><dd>{(s.start / src.sampleRate).toFixed(3)} – {(s.end / src.sampleRate).toFixed(3)} s</dd>
        <dt>Duration</dt><dd>{fmtDur(s.end - s.start, src.sampleRate)}</dd>
        {a && (
          <>
            <dt>Approx. pitch</dt><dd>{a.pitch != null ? `${midiToName(a.pitch)} (${a.pitch.toFixed(1)}, conf ${Math.round(a.pitchConfidence * 100)}%)` : 'unpitched / unclear'}</dd>
            <dt>Attack</dt><dd>{Math.round(a.attack * 100)}%</dd>
            <dt>Sustain</dt><dd>{Math.round(a.sustain * 100)}%</dd>
            <dt>Noisiness</dt><dd>{Math.round(a.noisiness * 100)}%</dd>
            <dt>Intensity</dt><dd>{Math.round(a.intensity * 100)}%</dd>
          </>
        )}
      </dl>
      <div className="row tight">
        <Btn small onClick={() => auditionSlice(s.id)}>▶ Play</Btn>
        <Btn small onClick={() => auditionSlice(s.id, { reverse: true })}>◀ Reverse</Btn>
        <Btn small onClick={() => auditionSlice(s.id, { semitones: 12 })}>+12</Btn>
        <Btn small onClick={() => auditionSlice(s.id, { semitones: -12 })}>−12</Btn>
      </div>
      <p className="dim" style={{ margin: 0, fontSize: 11 }}>Pitch is a rough estimate; ±12 audition uses playback-rate transposition (pitch and length change together).</p>
    </Section>
  );
}

const METHODS: { value: SuggestMethod; label: string }[] = [
  { value: 'silence', label: 'Silence / low energy' },
  { value: 'onset', label: 'Amplitude onsets' },
  { value: 'transient', label: 'Transients (finer)' },
  { value: 'interval', label: 'Fixed time interval' },
  { value: 'beat', label: 'Beat grid (needs BPM)' },
  { value: 'rhythm', label: 'Rhythmic pattern' },
];

export function SliceView() {
  const doc = useStore((s) => s.doc);
  const ui = useStore((s) => s.ui);
  const setUI = useStore((s) => s.setUI);
  const peaks = useStore((s) => (s.ui.sourceId ? s.rt.peaks.get(s.ui.sourceId) : undefined));
  useStore((s) => s.rtVersion);
  const src = doc.sources.find((s) => s.id === ui.sourceId) ?? doc.sources[0];
  const srcSlices = useMemo(() => (src ? doc.slices.filter((s) => s.sourceId === src.id) : []), [doc.slices, src]);
  const selected = srcSlices.filter((s) => ui.sliceIds.includes(s.id));
  const [region, setRegion] = useState<Region | null>(null);
  const [cursor, setCursor] = useState(0);
  const [markers, setMarkers] = useState<number[]>([]);
  const [level, setLevel] = useState<SliceLevel>('syllable');
  const [zoom, setZoom] = useState<{ n: number; kind: 'in' | 'out' | 'fit' | 'region' } | null>(null);
  const [method, setMethod] = useState<SuggestMethod>('onset');
  const [param, setParam] = useState({ intervalSec: 0.25, division: 2, sensitivity: 0.5, thresholdDb: -35, pattern: '0.75 0.75 0.5', bpm: 120, subN: 4 });

  useEffect(() => {
    if (!ui.sourceId && doc.sources[0]) setUI({ sourceId: doc.sources[0].id });
  }, [ui.sourceId, doc.sources, setUI]);
  useEffect(() => {
    setMarkers([]);
    setRegion(null);
    setCursor(0);
  }, [src?.id]);

  const audio = src ? useStore.getState().rt.audio.get(src.id) : undefined;
  const range = (): [number, number] => (region ? [region.start, region.end] : selected[0] ? [selected[0].start, selected[0].end] : [0, src?.frames ?? 0]);

  const createFromRegion = () => {
    if (!src || !region) return;
    const parent = srcSlices.find((s) => s.level !== level && SLICE_LEVELS.indexOf(s.level) < SLICE_LEVELS.indexOf(level) && s.start <= region.start && s.end >= region.end);
    const n = srcSlices.filter((s) => s.level === level).length + 1;
    actions.addSlices([makeSlice(src, region.start, region.end, level, { name: `${LEVEL_PREFIX[level]}${n}`, parentId: parent?.id })]);
  };
  const sliceAtMarkers = () => {
    if (!src || !markers.length) return;
    const [a, b] = range();
    const n0 = srcSlices.filter((s) => s.level === level).length;
    const made = slicesFromBoundaries(src, a, b, markers, level).map((s, i) => ({ ...s, name: `${LEVEL_PREFIX[level]}${n0 + i + 1}`, parentId: selected[0] && selected[0].level !== level ? selected[0].id : undefined }));
    actions.addSlices(made);
    setMarkers([]);
  };
  const suggest = () => {
    if (!src || !audio) return;
    const [a, b] = range();
    const m = suggestBoundaries(audio, a, b, {
      method,
      intervalSec: param.intervalSec,
      bpm: method === 'beat' ? src.bpm ?? doc.sequence.bpm : param.bpm,
      division: param.division,
      sensitivity: param.sensitivity,
      thresholdDb: param.thresholdDb,
      pattern: param.pattern.split(/[\s,]+/).map(Number).filter((x) => x > 0),
    });
    setMarkers(m);
    useStore.getState().toast(`${m.length} suggested boundaries – drag to correct, then “Slice at markers”`);
  };
  const silenceSlices = () => {
    if (!src || !audio) return;
    const [a, b] = range();
    const regs = detectSoundRegionsFor(audio, a, b, param.thresholdDb);
    const n0 = srcSlices.filter((s) => s.level === level).length;
    actions.addSlices(regs.map((r, i) => makeSlice(src, r.start, r.end, level, { name: `${LEVEL_PREFIX[level]}${n0 + i + 1}`, parentId: selected[0]?.id })));
  };
  const split = () => {
    const s = selected[0];
    if (!s) return;
    const r = splitSlice(s, cursor);
    if (!r) return useStore.getState().toast('Place the cursor inside the selected slice to split it', 'error');
    actions.replaceSlices([s.id], r.map((x) => ({ ...x, analysis: undefined })), 'Split slice');
  };
  const merge = () => {
    if (selected.length === 2) {
      const m = mergeSlices(selected[0], selected[1]);
      if (!m) return useStore.getState().toast('Only slices of the same level can be merged', 'error');
      actions.replaceSlices(selected.map((s) => s.id), [m], 'Merge slices');
      return;
    }
    const s = selected[0];
    if (!s) return;
    const next = srcSlices.filter((x) => x.level === s.level && x.start >= s.end - 2).sort((a, b) => a.start - b.start)[0];
    if (!next) return;
    const m = mergeSlices(s, next);
    if (m) actions.replaceSlices([s.id, next.id], [m], 'Merge slices');
  };
  const subdivideSel = (how: 'onsets' | 'equal') => {
    const s = selected[0];
    if (!s || !src || !audio) return;
    let b: number[];
    if (how === 'equal') b = Array.from({ length: param.subN - 1 }, (_, i) => Math.round(s.start + ((s.end - s.start) * (i + 1)) / param.subN));
    else b = suggestBoundaries(audio, s.start, s.end, { method: 'onset', sensitivity: Math.max(0.6, param.sensitivity) });
    const kids = subdivide(s, src, b, CHILD_LEVEL[s.level]);
    if (kids.length < 2) return useStore.getState().toast('No inner boundaries found – try “equal parts” or markers', 'error');
    actions.addSlices(kids);
  };
  const duplicate = () => {
    if (!selected.length) return;
    actions.addSlices(selected.map((s) => ({ ...s, id: uid('sl'), name: `${s.name} copy`, favourite: false })));
  };
  const autoChopSrc = () => {
    if (!src || !audio) return;
    const { slices } = autoChop(src, audio, { sensitivity: param.sensitivity });
    actions.addSlices(slices, false);
    useStore.getState().toast(`Added ${slices.length} suggested slices (existing slices kept)`, 'success');
  };

  // keyboard shortcuts inside the slicing studio
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (ui.sliceIds.length) actions.removeSlices(ui.sliceIds);
      } else if (e.key === 'Enter') createFromRegion();
      else if (e.key.toLowerCase() === 'm' && !e.ctrlKey) setMarkers((m) => [...m, cursor].sort((a, b) => a - b));
      else if (e.key.toLowerCase() === 'p' && src) {
        const [a, b] = range();
        auditionRegion(src.id, a, b);
      } else if (e.key.toLowerCase() === 'f' && selected[0]) actions.updateSlice(selected[0].id, { favourite: !selected[0].favourite }, 'Favourite');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!src)
    return (
      <div className="view slice-view">
        <SourcesPanel />
        <main className="main">
          <Welcome />
        </main>
        <aside className="panel right" />
      </div>
    );

  return (
    <div className="view slice-view">
      <SourcesPanel />
      <main className="main">
        <div className="toolbar">
          <Btn small onClick={() => setZoom({ n: Date.now(), kind: 'in' })} title="Zoom in">＋</Btn>
          <Btn small onClick={() => setZoom({ n: Date.now(), kind: 'out' })} title="Zoom out">－</Btn>
          <Btn small onClick={() => setZoom({ n: Date.now(), kind: 'fit' })}>Fit</Btn>
          <Btn small disabled={!region} onClick={() => setZoom({ n: Date.now(), kind: 'region' })}>Zoom to selection</Btn>
          <span className="sep" />
          <Btn small testid="play-source" onClick={() => auditionRegion(src.id, 0, src.frames)}>▶ Source</Btn>
          <Btn small testid="play-region" onClick={() => { const [a, b] = range(); auditionRegion(src.id, a, b); }} title="P">▶ Selection</Btn>
          <Btn small onClick={() => engine.stopAudition()}>■</Btn>
          <span className="sep" />
          <Select value={level} options={SLICE_LEVELS.map((l) => ({ value: l, label: `${l} level` }))} onChange={setLevel} testid="new-level" />
          <Btn small kind="primary" testid="create-slice" disabled={!region} onClick={createFromRegion} title="Enter">Slice selection</Btn>
          <Btn small testid="add-marker" onClick={() => setMarkers([...markers, cursor].sort((a, b) => a - b))} title="M">＋ Marker</Btn>
          <Btn small testid="slice-markers" disabled={!markers.length} onClick={sliceAtMarkers}>Slice at markers ({markers.length})</Btn>
          <Btn small disabled={!markers.length} onClick={() => setMarkers([])}>Clear markers</Btn>
          <span className="sep" />
          <Btn small testid="split" disabled={selected.length !== 1} onClick={split} title="Split the selected slice at the cursor">Split</Btn>
          <Btn small testid="merge" disabled={!selected.length} onClick={merge}>Merge</Btn>
          <Btn small testid="subdivide" disabled={selected.length !== 1} onClick={() => subdivideSel('onsets')} title="Create child slices at the next level from onsets (parent kept)">Sub-slice (onsets)</Btn>
          <Btn small disabled={selected.length !== 1} onClick={() => subdivideSel('equal')}>Sub-slice ÷{param.subN}</Btn>
          <Btn small testid="duplicate-slice" disabled={!selected.length} onClick={duplicate}>Duplicate</Btn>
          <Btn small kind="danger" testid="delete-slice" disabled={!selected.length} onClick={() => actions.removeSlices(ui.sliceIds)}>Delete</Btn>
          <span className="sep" />
          <Btn small testid="auto-chop" onClick={autoChopSrc} title="Suggest phrase, word and syllable slices">Auto-chop</Btn>
        </div>
        <div className="wave-wrap" style={{ overflow: 'auto' }}>
          <Waveform
            source={src}
            peaks={peaks}
            slices={srcSlices}
            selected={ui.sliceIds}
            markers={markers}
            region={region}
            cursor={cursor}
            onRegion={setRegion}
            onCursor={setCursor}
            onMarkers={setMarkers}
            onSelect={(ids, add) => setUI({ sliceIds: add ? Array.from(new Set([...ui.sliceIds, ...ids])) : ids })}
            onEdgeDragStart={() => useStore.getState().beginGesture()}
            onEdgeDrag={(id, patch) => useStore.getState().gesture((d) => { const s = d.slices.find((x) => x.id === id); if (s) Object.assign(s, patch); })}
            onEdgeDragEnd={(id) => {
              const s = useStore.getState().doc.slices.find((x) => x.id === id);
              if (s) useStore.getState().gesture((d) => { const t = d.slices.find((x) => x.id === id); if (t) t.analysis = analysisFor({ ...s, analysis: undefined }).analysis as any; });
              useStore.getState().endGesture('Adjust slice boundary');
            }}
            onAudition={(s) => auditionSlice(s.id)}
            zoomCmd={zoom}
          />
          <div style={{ padding: '10px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="suggest-box">
              <b style={{ fontSize: 12 }}>Suggest boundaries</b>
              <span className="dim" style={{ fontSize: 11 }}>Applies to the selected region, else the selected slice, else the whole source. Suggestions are markers you can correct.</span>
              <div className="row">
                <Select label="Method" value={method} options={METHODS} onChange={setMethod} testid="suggest-method" />
                {method === 'interval' && <NumberField label="Interval (s)" value={param.intervalSec} step={0.01} min={0.01} onChange={(v) => setParam({ ...param, intervalSec: v })} />}
                {(method === 'beat' || method === 'rhythm') && <NumberField label="BPM" value={method === 'beat' ? src.bpm ?? doc.sequence.bpm : param.bpm} onChange={(v) => (method === 'beat' ? actions.updateSource(src.id, { bpm: v }) : setParam({ ...param, bpm: v }))} />}
                {method === 'beat' && <NumberField label="Per beat" value={param.division} min={1} max={8} onChange={(v) => setParam({ ...param, division: v })} />}
                {method === 'rhythm' && <TextField label="Pattern (beats)" value={param.pattern} onChange={(v) => setParam({ ...param, pattern: v })} />}
                {method === 'silence' && <NumberField label="Threshold dB" value={param.thresholdDb} max={-6} min={-70} onChange={(v) => setParam({ ...param, thresholdDb: v })} />}
              </div>
              {(method === 'onset' || method === 'transient') && <Slider label="Sensitivity" value={param.sensitivity} onChange={(v) => setParam({ ...param, sensitivity: v })} />}
              <div className="row tight">
                <Btn small kind="primary" testid="suggest" onClick={suggest}>Suggest markers</Btn>
                {method === 'silence' && <Btn small onClick={silenceSlices}>Slice sound regions</Btn>}
                <NumberField label="÷ parts" value={param.subN} min={2} max={32} width={50} onChange={(v) => setParam({ ...param, subN: v })} />
              </div>
            </div>
            <div className="suggest-box">
              <b style={{ fontSize: 12 }}>Slices in this source</b>
              <div style={{ maxHeight: 160, overflow: 'auto' }} data-testid="slice-list">
                {SLICE_LEVELS.map((l) => {
                  const ls = srcSlices.filter((s) => s.level === l).sort((a, b) => a.start - b.start);
                  if (!ls.length) return null;
                  return (
                    <div key={l} style={{ marginBottom: 6 }}>
                      <span className="lbl">{l} · {ls.length}</span>
                      <div className="tags">
                        {ls.map((s) => (
                          <span key={s.id} className={`chip ${ui.sliceIds.includes(s.id) ? 'on' : ''}`} style={{ cursor: 'pointer' }} onClick={(e) => { setUI({ sliceIds: e.shiftKey ? [...ui.sliceIds, s.id] : [s.id] }); setRegion({ start: s.start, end: s.end }); auditionSlice(s.id); }}>
                            {s.favourite ? '★' : ''}{s.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </main>
      <aside className="panel right">
        <SliceInspector slices={selected} />
        <Section title="Next step">
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>You don’t need to label everything. Categories and favourites are used as tendencies when composing.</p>
          <Btn kind="primary" testid="go-compose" onClick={() => setUI({ view: 'compose' })}>Compose with these slices →</Btn>
        </Section>
      </aside>
    </div>
  );
}

export function Welcome() {
  const setUI = useStore((s) => s.setUI);
  return (
    <div className="welcome">
      <h1>Turn one vocal into many musical ideas.</h1>
      <p className="muted" style={{ margin: 0 }}>Vocal Chop Studio chops vocals into reusable fragments and composes hooks, rhythmic chops, ghost textures, reconstructed phrases and conversations from them – then exports WAV/MIDI for your DAW. Everything runs offline.</p>
      <div className="steps">
        <div className="step"><b>1</b><div>Import, record or add a demo vocal</div></div>
        <div className="step"><b>2</b><div>Chop automatically or by hand</div></div>
        <div className="step"><b>3</b><div>Pick a mode & direction, generate ideas</div></div>
        <div className="step"><b>4</b><div>Audition, keep, edit, export</div></div>
      </div>
      <div className="row">
        <Btn kind="primary" onClick={() => pickAndImportAudio()}>＋ Import audio</Btn>
        <Btn onClick={() => setUI({ showRecorder: true })}>● Record</Btn>
        <Btn testid="welcome-demo" onClick={() => addDemoVoice('sung-phrase')}>Add demo vocal</Btn>
      </div>
      <ExamplesGrid />
    </div>
  );
}

import { EXAMPLES } from '../../core/demo/examples';
import { loadExample } from '../services/projectService';
function ExamplesGrid() {
  return (
    <>
      <h3 className="muted" style={{ margin: '8px 0 0', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Example projects</h3>
      <div className="examples">
        {Object.entries(EXAMPLES).map(([k, e]) => (
          <button key={k} className="example" data-testid={`welcome-example-${k}`} onClick={() => loadExample(k)}>
            <b>{e.title}</b>
            <small>{e.workflow}</small>
          </button>
        ))}
      </div>
    </>
  );
}

void Toggle;
