import React, { useMemo, useState } from 'react';
import { useStore, actions } from '../store/store';
import type { SliceCategory, SliceLevel } from '../../core/types';
import { SLICE_CATEGORIES, SLICE_LEVELS } from '../../core/types';
import { Btn, Section, Select, TextField, Toggle, Empty } from '../components/ui';
import { WaveThumb } from '../components/WaveThumb';
import { auditionSlice } from '../transport';
import { midiToName } from '../../core/time';
import { uid } from '../../core/ids';
import { exportSlices } from '../../core/project/exporters';
import { platform } from '../platform/platform';
import { safeName } from '../../core/midi/midi';

const LEVEL_COLOR: Record<SliceLevel, string> = { phrase: '#b48cff', word: '#ff6fa8', syllable: '#5ee0c1', sound: '#ffc861' };

export function LibraryView() {
  const doc = useStore((s) => s.doc);
  const ui = useStore((s) => s.ui);
  const setUI = useStore((s) => s.setUI);
  const rt = useStore((s) => s.rt);
  const [q, setQ] = useState('');
  const [level, setLevel] = useState<'' | SliceLevel>('');
  const [cat, setCat] = useState<'' | SliceCategory>('');
  const [src, setSrc] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState<'source' | 'duration' | 'pitch' | 'attack'>('source');
  const [newName, setNewName] = useState('');
  const srcMap = new Map(doc.sources.map((s) => [s.id, s]));

  const list = useMemo(() => {
    const f = doc.slices.filter(
      (s) =>
        (!q || `${s.name} ${s.tags.join(' ')} ${s.category ?? ''} ${s.notes ?? ''}`.toLowerCase().includes(q.toLowerCase())) &&
        (!level || s.level === level) &&
        (!cat || s.category === cat) &&
        (!src || s.sourceId === src) &&
        (!favOnly || s.favourite),
    );
    const sr = (id: string) => srcMap.get(id)?.sampleRate ?? 44100;
    return f.sort((a, b) =>
      sort === 'duration' ? (b.end - b.start) / sr(b.sourceId) - (a.end - a.start) / sr(a.sourceId) :
      sort === 'pitch' ? (b.analysis?.pitch ?? -1) - (a.analysis?.pitch ?? -1) :
      sort === 'attack' ? (b.analysis?.attack ?? 0) - (a.analysis?.attack ?? 0) :
      a.sourceId.localeCompare(b.sourceId) || a.start - b.start,
    );
  }, [doc.slices, q, level, cat, src, favOnly, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = ui.sliceIds;
  const click = (id: string, e: React.MouseEvent) => {
    setUI({ sliceIds: e.shiftKey || e.metaKey || e.ctrlKey ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id] });
    auditionSlice(id);
  };
  const exportFiles = async (ids: string[], label: string) => {
    const files = exportSlices(doc, rt.audio, ids, doc.exportSettings);
    const where = await platform.writeExport(files, safeName(label));
    if (where) useStore.getState().toast(`Exported ${files.length} slice WAVs → ${where}`, 'success');
  };
  const selectedEvents = doc.sequence.events.filter((e) => ui.eventIds.includes(e.id));

  return (
    <div className="view library-view">
      <main className="main">
        <div className="toolbar">
          <TextField value={q} onChange={setQ} placeholder="Search name, tag, category…" testid="lib-search" />
          <Select value={level} options={[{ value: '', label: 'All levels' }, ...SLICE_LEVELS.map((l) => ({ value: l, label: l }))]} onChange={setLevel} />
          <Select value={cat} options={[{ value: '', label: 'All categories' }, ...SLICE_CATEGORIES.map((c) => ({ value: c, label: c }))]} onChange={setCat} testid="lib-category" />
          <Select value={src} options={[{ value: '', label: 'All sources' }, ...doc.sources.map((s) => ({ value: s.id, label: s.name }))]} onChange={setSrc} />
          <Toggle label="★ only" value={favOnly} onChange={setFavOnly} testid="lib-fav" />
          <Select value={sort} options={[{ value: 'source', label: 'Sort: source order' }, { value: 'duration', label: 'Sort: longest' }, { value: 'pitch', label: 'Sort: highest pitch' }, { value: 'attack', label: 'Sort: sharpest attack' }]} onChange={setSort} />
          <span className="dim">{list.length} slices · {sel.length} selected</span>
          <div className="spacer" />
          <Btn small onClick={() => setUI({ sliceIds: list.map((s) => s.id) })}>Select all shown</Btn>
          <Btn small disabled={!sel.length} onClick={() => useStore.getState().commit('Favourite', (d) => d.slices.forEach((s) => sel.includes(s.id) && (s.favourite = true)))}>★ Favourite</Btn>
          <Btn small disabled={!sel.length} onClick={() => { actions.setSettings({ sliceIds: sel.slice(), materialKey: 'selection' }); setUI({ view: 'compose' }); }} testid="compose-selection">Compose with selection →</Btn>
        </div>
        {!list.length ? (
          <div style={{ padding: 20 }}><Empty>No slices match. Create slices in Sources &amp; Slices.</Empty></div>
        ) : (
          <div className="slice-grid" data-testid="slice-grid">
            {list.map((s) => {
              const source = srcMap.get(s.sourceId);
              const a = rt.audio.get(s.sourceId);
              const dur = source ? (s.end - s.start) / source.sampleRate : 0;
              return (
                <div key={s.id} className={`slice-card ${sel.includes(s.id) ? 'sel' : ''}`} data-testid="slice-card" onClick={(e) => click(s.id, e)} onDoubleClick={() => setUI({ view: 'slice', sourceId: s.sourceId, sliceIds: [s.id] })}>
                  <div className="top">
                    <b>{s.name}</b>
                    <button className={`star ${s.favourite ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); actions.updateSlice(s.id, { favourite: !s.favourite }, 'Favourite'); }}>★</button>
                  </div>
                  {a ? <WaveThumb peaks={rt.peaks.get(s.sourceId)} start={s.start} end={s.end} color={LEVEL_COLOR[s.level]} /> : <div className="dim" style={{ height: 34 }}>missing audio</div>}
                  <div className="sub">
                    <span>{s.level} · {s.category ?? '—'}</span>
                    <span>{dur < 1 ? `${Math.round(dur * 1000)}ms` : `${dur.toFixed(2)}s`}{s.analysis?.pitch != null ? ` · ${midiToName(s.analysis.pitch)}` : ''}</span>
                  </div>
                  <div className="sub"><span className="dim">{source?.name}</span>{s.tags.filter((t) => t !== 'auto').length > 0 && <span>{s.tags.filter((t) => t !== 'auto').join(', ')}</span>}</div>
                </div>
              );
            })}
          </div>
        )}
      </main>
      <aside className="panel right">
        <Section title="Collections">
          <div className="row tight">
            <TextField value={newName} onChange={setNewName} placeholder="New collection name" testid="collection-name" />
            <Btn small testid="create-collection" disabled={!sel.length} onClick={() => {
              const name = newName || `Collection ${doc.collections.length + 1}`;
              useStore.getState().commit('New collection', (d) => void d.collections.push({ id: uid('col'), name, sliceIds: sel.slice() }));
              setNewName('');
            }}>Create from {sel.length}</Btn>
          </div>
          {!doc.collections.length && <Empty>Group favourite fragments into reusable collections. Collections can drive the generator and be exported.</Empty>}
          {doc.collections.map((c) => (
            <div key={c.id} className="collection" data-testid="collection">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <b>{c.name}</b>
                <span className="dim">{c.phrase ? `phrase · ${c.phrase.events.length} events` : `${c.sliceIds.length} slices`}</span>
              </div>
              <div className="row tight">
                <Btn small onClick={() => setUI({ sliceIds: c.sliceIds.slice() })}>Select</Btn>
                <Btn small disabled={!sel.length} onClick={() => useStore.getState().commit('Add to collection', (d) => { const x = d.collections.find((y) => y.id === c.id); if (x) x.sliceIds = Array.from(new Set([...x.sliceIds, ...sel])); })}>+ Selected</Btn>
                <Btn small onClick={() => { actions.setSettings({ sliceIds: c.sliceIds.slice(), materialKey: `collection:${c.id}` }); setUI({ view: 'compose' }); }}>Compose</Btn>
                <Btn small onClick={() => exportFiles(c.sliceIds, c.name)}>Export</Btn>
                {c.phrase && <Btn small onClick={() => insertPhrase(c.id)}>Insert at playhead</Btn>}
                <Btn small kind="ghost" onClick={() => useStore.getState().commit('Delete collection', (d) => void (d.collections = d.collections.filter((x) => x.id !== c.id)))}>✕</Btn>
              </div>
            </div>
          ))}
        </Section>
        <Section title="Reusable phrases">
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Save selected timeline events as a phrase and drop it into any arrangement later.</p>
          <Btn small testid="save-phrase" disabled={!selectedEvents.length} onClick={() => {
            const t0 = Math.min(...selectedEvents.map((e) => e.tick));
            const t1 = Math.max(...selectedEvents.map((e) => e.tick + e.length));
            const phraseEvents = selectedEvents.map(({ id, trackId, ...rest }) => ({ ...rest, tick: rest.tick - t0, locked: false }));
            useStore.getState().commit('Save phrase', (d) => void d.collections.push({ id: uid('col'), name: `Phrase ${d.collections.length + 1}`, sliceIds: Array.from(new Set(selectedEvents.map((e) => e.sliceId))), phrase: { events: phraseEvents, span: t1 - t0 } }));
            useStore.getState().toast('Phrase saved to collections', 'success');
          }}>Save {selectedEvents.length} selected events as phrase</Btn>
        </Section>
        <Section title="Selection">
          <Btn small disabled={!sel.length} onClick={() => exportFiles(sel, 'selected-slices')} testid="export-selected-slices">Export {sel.length} selected as WAV</Btn>
          <Btn small kind="danger" disabled={!sel.length} onClick={() => window.confirm(`Delete ${sel.length} slice definitions? (Source audio is never changed.)`) && actions.removeSlices(sel)}>Delete slice definitions</Btn>
        </Section>
      </aside>
    </div>
  );
}

function insertPhrase(collectionId: string) {
  const st = useStore.getState();
  const c = st.doc.collections.find((x) => x.id === collectionId);
  if (!c?.phrase) return;
  const trackId = st.ui.trackId ?? st.doc.sequence.tracks[0]?.id;
  if (!trackId) return st.toast('Add a layer first', 'error');
  const at = Math.round(st.positionTick / st.doc.sequence.grid) * st.doc.sequence.grid;
  const total = st.doc.sequence.bars * 3840;
  actions.addEvents(c.phrase.events.map((e) => ({ ...e, id: uid('ev'), trackId, tick: e.tick + at })).filter((e) => e.tick < total));
  st.setUI({ view: 'compose' });
}
