import React, { useEffect, useMemo, useState } from 'react';
import { useStore, actions } from '../store/store';
import type { Candidate, Slice, SourceAudio, ScaleName } from '../../core/types';
import { slicePitch } from '../../core/slicing/slices';
import { similarChops } from '../../core/compose/ideaEdit';
import { keyName } from '../../core/beat/analyze';
import { effectiveKey } from '../../core/beat/fit';
import { midiToName, NOTE_NAMES, ticksPerBar } from '../../core/time';
import { WaveThumb } from '../components/WaveThumb';
import { auditionSlice, stop } from '../transport';
import { pickAndImportAudio, addDemoVoice, openProject } from '../services/projectService';
import { pickBeatFile, setBeatEnabled, removeBeat } from '../services/beatService';
import { dragIdea, prepareDrag, quickExport, dragSlice, prepareSliceDrag, canDragOut } from '../services/exportService';
import {
  ideasFor, generateMix, generateStyle, moreLikeThis, surprise, toggleIdea, playIdea, swapIdeaChop, shuffleIdea, transposeIdeaBy,
  setIdeaSwing, toggleLayer, toggleLike, deleteIdea, openInEditor, saveIdeaStems, saveIdeaMidi, ensureKey,
} from '../services/studioService';
import { STYLES, styleById, DEFAULT_TWEAKS, type StudioTweaks } from '../studio/styles';
import { EXAMPLES } from '../../core/demo/examples';
import { loadExample } from '../services/projectService';

const st = () => useStore.getState();
const isDesktop = canDragOut();

/* ───────────── empty state ───────────── */

function StudioEmpty() {
  const setUI = useStore((s) => s.setUI);
  const pick = async () => {
    await pickAndImportAudio();
    if (st().doc.slices.length) void generateMix();
  };
  const demo = () => {
    addDemoVoice('sung-phrase');
    void generateMix();
  };
  return (
    <div className="studio-empty" data-testid="studio-empty">
      <h1>Drop a vocal. Get chops.</h1>
      <p className="muted">It gets chopped automatically, its key is found, and ideas are written in ten styles. Play them, swap the chops, then drag what you like into your DAW.</p>
      <button className="big-drop" data-drop="vocal" data-testid="studio-drop" onClick={() => void pick()}>
        <span className="big-drop-icon">⬇</span>
        <b>Drop a vocal here</b>
        <span className="muted">or click to choose · WAV, MP3, FLAC, OGG, M4A</span>
      </button>
      <div className="row tight" style={{ justifyContent: 'center' }}>
        <button className="btn" data-testid="studio-record" onClick={() => setUI({ showRecorder: true })}>● Record</button>
        <button className="btn" data-testid="welcome-demo" onClick={demo}>✦ Try a demo vocal</button>
      </div>
      <div className="how">
        <div><b>1</b>Drop a vocal</div>
        <div><b>2</b>Play ideas · dive into a style · swap chops</div>
        <div><b>3</b>Drag into your DAW</div>
      </div>
      <p className="dim small">Got a beat? Drop its MIDI (chords, bass, drums…) too – ideas then follow its key, chords and groove.</p>
      <div className="row tight dim small" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="link" onClick={() => void openProject()}>Open a project…</button>
        <span>·</span>
        <span>Examples:</span>
        {Object.entries(EXAMPLES).map(([k, e]) => (
          <button key={k} className="link" data-testid={`welcome-example-${k}`} onClick={() => loadExample(k)}>{e.title.replace(/^[A-G] · /, '')}</button>
        ))}
      </div>
    </div>
  );
}

/* ───────────── top strip: vocal, key, length, beat ───────────── */

function VocalStrip({ pads }: { pads: Slice[] }) {
  const doc = useStore((s) => s.doc);
  const ui = useStore((s) => s.ui);
  const rt = useStore((s) => s.rt);
  useStore((s) => s.rtVersion);
  const sources = doc.sources.filter((s) => s.kind !== 'derived' && !s.missing);
  const vocal = ui.studioVocal && ui.studioVocal !== 'all' ? ui.studioVocal : sources[0]?.id;
  const src = doc.sources.find((s) => s.id === vocal);
  const s = doc.sequence.settings;
  const beat = doc.beat;
  const beatKey = beat?.enabled ? effectiveKey(beat) : null;
  const regions = src ? pads.filter((p) => p.sourceId === src.id) : [];
  const keyValue = s.keyAuto === false ? `${s.keyRoot}:${s.scale}` : 'auto';
  const setKey = (v: string) => {
    if (v === 'auto') {
      actions.setSettings({ keyAuto: true });
      const k = ensureKey();
      st().toast(k ? `Key follows your vocal: ${k}` : 'Not enough pitched material to find a key', 'info');
    } else {
      const [r, sc] = v.split(':');
      actions.setSettings({ keyRoot: Number(r), scale: sc as ScaleName, keyAuto: false });
    }
  };
  const bar = ticksPerBar(doc.sequence.timeSig);
  return (
    <div className="vocal-strip" data-testid="vocal-strip">
      <div className="vs-left">
        {sources.length > 1 ? (
          <select data-testid="studio-vocal" value={ui.studioVocal ?? 'all'} onChange={(e) => st().setUI({ studioVocal: e.target.value })}>
            <option value="all">All vocals ({sources.length})</option>
            {sources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        ) : (
          <b className="vs-name" title={src?.name}>{src?.name}</b>
        )}
        <div className="row tight">
          <button className="btn small" onClick={async () => { const n = st().doc.sources.length; await pickAndImportAudio(); if (st().doc.sources.length > n) void generateMix(); }}>＋ Vocal</button>
          <button className="btn small" onClick={() => st().setUI({ showRecorder: true })}>● Rec</button>
        </div>
      </div>
      <div className="vs-wave" data-testid="vs-wave">
        {src && <WaveThumb peaks={rt.peaks.get(src.id)} data={rt.audio.get(src.id)} height={46} color="#5c6690" />}
        {src &&
          regions.map((p) => (
            <button
              key={p.id}
              className="vs-region"
              style={{ left: `${(p.start / src.frames) * 100}%`, width: `${Math.max(0.3, ((p.end - p.start) / src.frames) * 100)}%` }}
              title={`${p.name} – click to play`}
              onClick={() => auditionSlice(p.id)}
            />
          ))}
      </div>
      <div className="vs-right">
        <label className="vs-field">
          <span>Key</span>
          {beatKey ? (
            <b title="From your beat">{keyName(beatKey.root, beatKey.scale)}</b>
          ) : (
            <select data-testid="studio-key" value={keyValue} onChange={(e) => setKey(e.target.value)}>
              <option value="auto">Auto{s.keyAuto !== false && s.keyRoot != null ? ` · ${keyName(s.keyRoot, s.scale)}` : ''}</option>
              {(['minor', 'major'] as ScaleName[]).flatMap((sc) => NOTE_NAMES.map((n, i) => <option key={`${i}:${sc}`} value={`${i}:${sc}`}>{n} {sc}</option>))}
            </select>
          )}
        </label>
        <label className="vs-field">
          <span>Length</span>
          <div className="seg">
            {[4, 8, 16].map((b) => (
              <button key={b} className={doc.sequence.bars === b ? 'on' : ''} data-testid={`studio-bars-${b}`} onClick={() => actions.updateSeq({ bars: b, loop: { enabled: true, startTick: 0, endTick: b * bar } }, 'Length')}>{b}</button>
            ))}
          </div>
        </label>
        {beat ? (
          <div className={`beat-pill ${beat.enabled ? 'on' : ''}`} data-testid="studio-beat">
            <label title="Fit ideas to your beat">
              <input type="checkbox" checked={beat.enabled} onChange={(e) => setBeatEnabled(e.target.checked)} />
              <span>Beat: {beat.chords.slice(0, 4).map((c) => c.symbol).join('–')}</span>
            </label>
            <button className="x" title="Open Beat Fit" onClick={() => st().setUI({ view: 'beat' })}>⚙</button>
            <button className="x" title="Remove beat" onClick={() => removeBeat()}>✕</button>
          </div>
        ) : (
          <button className="btn small beat-add" data-drop="beat" data-testid="studio-add-beat" onClick={() => void pickBeatFile().then(() => { if (st().doc.beat && st().doc.slices.length) void generateMix(); })} title="Drop or choose the MIDI of your beat – ideas will follow its key, chords and groove">
            🎹 Fit to my beat
          </button>
        )}
      </div>
    </div>
  );
}

/* ───────────── styles ───────────── */

const PURPOSES: [StudioTweaks['purpose'], string][] = [['hook', 'Hook'], ['verse', 'Verse'], ['build', 'Build'], ['drop', 'Drop'], ['intro', 'Intro'], ['outro', 'Outro']];
const ENERGY: [StudioTweaks['energy'], string][] = [['chill', 'Chill'], ['mid', 'Medium'], ['hype', 'Hype']];
const REGISTER: [StudioTweaks['register'], string][] = [['low', 'Low'], ['mid', 'Mid'], ['high', 'High']];
const HALF: [StudioTweaks['half'], string][] = [['auto', 'Auto'], ['half', 'Half-time'], ['normal', 'Normal']];

function Pills<T extends string>({ label, value, options, onChange, testid }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; testid?: string }) {
  return (
    <div className="pills" data-testid={testid}>
      <span>{label}</span>
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => v !== value && onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

function StyleBar() {
  const tab = useStore((s) => s.ui.studioTab ?? 'all');
  const busy = useStore((s) => s.ui.studioBusy);
  const cands = useStore((s) => s.doc.candidates);
  const tweaks = useStore((s) => s.ui.studioTweaks ?? DEFAULT_TWEAKS);
  const style = styleById(tab);
  const liked = cands.filter((c) => c.favourite).length;
  const open = (id: string) => {
    st().setUI({ studioTab: id });
    // diving into a style writes six takes on it (once; “More …” adds more)
    if (styleById(id) && !cands.some((c) => c.style === id && c.profile !== 'studio')) void generateStyle(id);
  };
  const tweak = (patch: Partial<StudioTweaks>) => {
    st().setUI({ studioTweaks: { ...tweaks, ...patch } });
    if (style) void generateStyle(style.id);
  };
  return (
    <div className="style-bar">
      <div className="style-tabs" data-testid="style-tabs">
        <button className={`style-tab ${tab === 'all' ? 'on' : ''}`} data-testid="tab-all" onClick={() => st().setUI({ studioTab: 'all' })}>✦ All styles</button>
        {STYLES.map((s) => (
          <button key={s.id} className={`style-tab ${tab === s.id ? 'on' : ''}`} style={{ '--c': s.color } as React.CSSProperties} data-testid={`tab-${s.id}`} title={s.blurb} onClick={() => open(s.id)}>
            <i>{s.icon}</i> {s.label}
          </button>
        ))}
        <button className={`style-tab ${tab === 'liked' ? 'on' : ''}`} data-testid="tab-liked" onClick={() => st().setUI({ studioTab: 'liked' })}>♥ Liked{liked ? ` (${liked})` : ''}</button>
      </div>
      <div className="style-actions">
        {style ? (
          <div className="style-info" style={{ '--c': style.color } as React.CSSProperties}>
            <b><i>{style.icon}</i> {style.label}</b>
            <span className="muted">{style.blurb}</span>
            <div className="tweaks">
              <Pills label="Part" value={tweaks.purpose} options={PURPOSES} onChange={(v) => tweak({ purpose: v })} testid="tweak-purpose" />
              <Pills label="Energy" value={tweaks.energy} options={ENERGY} onChange={(v) => tweak({ energy: v })} testid="tweak-energy" />
              <Pills label="Pitch" value={tweaks.register} options={REGISTER} onChange={(v) => tweak({ register: v })} />
              <Pills label="Feel" value={tweaks.half} options={HALF} onChange={(v) => tweak({ half: v })} />
            </div>
          </div>
        ) : (
          <span className="muted">{tab === 'liked' ? 'Ideas you ♥. They are kept with the project.' : 'One idea per style. Click a style above to dive in and get six takes on it.'}</span>
        )}
        <div className="row tight" style={{ marginLeft: 'auto', alignItems: 'center' }}>
          {busy && <span className="busy" data-testid="studio-busy"><i />{busy}</span>}
          <button className="btn" data-testid="surprise" onClick={() => void surprise()} title="Random style, random settings">🎲 Surprise me</button>
          <button className="btn primary" data-testid="new-ideas" disabled={tab === 'liked'} onClick={() => void (style ? generateStyle(style.id) : generateMix())}>
            ✦ {style ? `More ${style.label}` : 'New ideas'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────── idea cards ───────────── */

function usePitchOf() {
  const slices = useStore((s) => s.doc.slices);
  const sources = useStore((s) => s.doc.sources);
  return useMemo(() => {
    const src = new Map(sources.map((x) => [x.id, x]));
    const m = new Map<string, number | null>();
    for (const s of slices) m.set(s.id, slicePitch(s, src.get(s.sourceId)));
    return m;
  }, [slices, sources]);
}

function Pattern({ c, total }: { c: Candidate; total: number }) {
  const pitchOf = usePitchOf();
  const notes = useMemo(() => {
    const col = new Map(c.tracks.map((t) => [t.id, t.color]));
    const muted = new Set(c.tracks.filter((t) => t.mute).map((t) => t.id));
    const ns = c.events.map((e) => {
      const p = pitchOf.get(e.sliceId);
      return { x: e.tick / total, w: Math.min(e.length, total / 8) / total, p: p == null ? null : p + e.semitones, color: col.get(e.trackId) ?? '#888', muted: muted.has(e.trackId) };
    });
    const ps = ns.map((n) => n.p).filter((p): p is number => p !== null);
    const lo = ps.length ? Math.min(...ps) - 1 : 0;
    const hi = ps.length ? Math.max(...ps) + 1 : 1;
    return ns.map((n) => ({ ...n, y: n.p === null ? 0.92 : 1 - (n.p - lo) / Math.max(6, hi - lo) }));
  }, [c, total, pitchOf]);
  return (
    <svg className="pattern" viewBox="0 0 300 60" preserveAspectRatio="none">
      {notes.map((n, i) => (
        <rect key={i} x={n.x * 300} y={n.y * 52 + 2} width={Math.max(2, n.w * 300)} height={4} rx={2} fill={n.color} opacity={n.muted ? 0.15 : 0.9} />
      ))}
    </svg>
  );
}

function Playhead({ id, total }: { id: string; total: number }) {
  const on = useStore((s) => s.playing && s.ui.auditioning === id);
  const pos = useStore((s) => (s.playing && s.ui.auditioning === id ? s.positionTick : 0));
  if (!on) return null;
  return <div className="playhead" style={{ left: `${Math.min(100, (pos / total) * 100)}%` }} />;
}

function IdeaCard({ c, total, selected }: { c: Candidate; total: number; selected: boolean }) {
  const playing = useStore((s) => s.playing && s.ui.auditioning === c.id);
  const style = styleById(c.style);
  return (
    <div
      className={`idea-card ${selected ? 'sel' : ''} ${playing ? 'playing' : ''} ${c.parentId ? 'child' : ''}`}
      style={{ '--c': style?.color ?? '#8f9bff' } as React.CSSProperties}
      data-testid="idea"
      data-idea={c.id}
      draggable
      onMouseEnter={() => void prepareDrag(c)}
      onDragStart={(e) => dragIdea(c, e)}
      onClick={() => toggleIdea(c.id)}
      title="Click to play · drag into your DAW"
    >
      <div className="ic-top">
        <span className="ic-style">{style ? <><i>{style.icon}</i> {style.label}</> : 'Editor idea'}</span>
        {c.score && <span className={`score ${c.score.total >= 80 ? 'hi' : c.score.total >= 60 ? 'mid' : 'lo'}`} title="Hook check (0–100)">{c.score.total}</span>}
        <button className={`heart ${c.favourite ? 'on' : ''}`} data-testid="like" title="Like (F)" onClick={(e) => { e.stopPropagation(); toggleLike(c.id); }}>♥</button>
      </div>
      <div className="ic-name">{c.label.replace(`${style?.label ?? ''} · `, '').replace(style?.label ?? '\u0000', '') || style?.label || c.label}</div>
      <div className="ic-pattern">
        <Pattern c={c} total={total} />
        <Playhead id={c.id} total={total} />
        <span className="ic-play">{playing ? '■' : '▶'}</span>
      </div>
      <div className="ic-foot">
        <span className="dim">⇱ drag</span>
        <button className="btn small ghost" data-testid="more-like" onClick={(e) => { e.stopPropagation(); void moreLikeThis(c.id); }} title="Four variations of this idea (V)">↻ More like this</button>
      </div>
    </div>
  );
}

function IdeaGrid() {
  const tab = useStore((s) => s.ui.studioTab ?? 'all');
  const cands = useStore((s) => s.doc.candidates);
  const sel = useStore((s) => s.ui.idea);
  const busy = useStore((s) => s.ui.studioBusy);
  const seq = useStore((s) => s.doc.sequence);
  const list = useMemo(() => ideasFor(tab, cands), [tab, cands]);
  const total = seq.bars * ticksPerBar(seq.timeSig);
  useEffect(() => {
    if (!sel || !list.some((c) => c.id === sel)) {
      if (list[0] && sel !== list[0].id) st().setUI({ idea: list[0].id });
    }
  }, [list, sel]);
  useEffect(() => {
    if (sel) document.querySelector(`[data-idea="${sel}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sel]);
  if (!list.length)
    return (
      <div className="idea-grid empty">
        {busy ? <span className="busy"><i />{busy}</span> : tab === 'liked' ? <span className="muted">Nothing liked yet – press ♥ on an idea you want to keep.</span> : (
          <button className="btn primary" onClick={() => void (styleById(tab) ? generateStyle(tab) : generateMix())}>✦ Write ideas</button>
        )}
      </div>
    );
  return (
    <div className="idea-grid" data-testid="idea-grid">
      {list.map((c) => <IdeaCard key={c.id} c={c} total={total} selected={c.id === sel} />)}
    </div>
  );
}

/* ───────────── selected idea ───────────── */

function ChopChip({ s, count, color, active, onClick }: { s: Slice; count: number; color: string; active: boolean; onClick: () => void }) {
  const rt = useStore((x) => x.rt);
  const src = useStore((x) => x.doc.sources.find((y) => y.id === s.sourceId));
  const pitch = slicePitch(s, src);
  return (
    <button className={`chop-chip ${active ? 'on' : ''}`} style={{ '--c': color } as React.CSSProperties} data-testid="chop-chip" onClick={onClick} onMouseEnter={() => auditionSlice(s.id)} title={`${s.name} · used ${count}× · click to swap`}>
      <WaveThumb peaks={rt.peaks.get(s.sourceId)} data={rt.audio.get(s.sourceId)} start={s.start} end={s.end} height={22} color={color} />
      <span>{s.name}{pitch != null ? ` · ${midiToName(Math.round(pitch))}` : ''}</span>
      <em>×{count}</em>
    </button>
  );
}

function SwapPicker({ idea, from, onSwapped }: { idea: Candidate; from: Slice; onSwapped: (id: string) => void }) {
  const slices = useStore((s) => s.doc.slices);
  const sources = useStore((s) => s.doc.sources);
  const rt = useStore((s) => s.rt);
  const [all, setAll] = useState(false);
  const used = useMemo(() => new Set(idea.events.map((e) => e.sliceId)), [idea]);
  const options = useMemo(() => similarChops(from, slices, sources, used).slice(0, all ? 80 : 12), [from, slices, sources, used, all]);
  const swap = (to: string) => {
    swapIdeaChop(idea.id, from.id, to);
    onSwapped(to);
    if (!st().playing) playIdea(idea.id);
  };
  return (
    <div className="swap-picker" data-testid="swap-picker">
      <div className="row tight" style={{ alignItems: 'center' }}>
        <span className="lbl">Swap “{from.name}” for… <span className="dim">(hover to hear · melody and rhythm stay)</span></span>
        <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => options[0] && swap(options[Math.floor(Math.random() * Math.min(5, options.length))].id)} title="A random close match">🎲</button>
      </div>
      <div className="swap-grid">
        {options.map((o) => (
          <button key={o.id} className="swap-opt" data-testid="swap-option" onMouseEnter={() => auditionSlice(o.id)} onClick={() => swap(o.id)}>
            <WaveThumb peaks={rt.peaks.get(o.sourceId)} data={rt.audio.get(o.sourceId)} start={o.start} end={o.end} height={20} color="#8f9bff" />
            <span>{o.name}</span>
          </button>
        ))}
      </div>
      {!all && <button className="link small" onClick={() => setAll(true)}>Show all chops</button>}
    </div>
  );
}

function IdeaPanel() {
  const id = useStore((s) => s.ui.idea);
  const c = useStore((s) => s.doc.candidates.find((x) => x.id === s.ui.idea));
  const slices = useStore((s) => s.doc.slices);
  const fx = useStore((s) => s.doc.fx) ?? { reverb: 0, delay: 0, print: false };
  const playing = useStore((s) => s.playing && s.ui.auditioning === id);
  const [swapFrom, setSwapFrom] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  useEffect(() => setSwapFrom(null), [id]);
  if (!c) return <aside className="idea-panel empty"><span className="muted">Pick an idea to play and shape it.</span></aside>;
  const style = styleById(c.style);
  const color = (trackId: string) => c.tracks.find((t) => t.id === trackId)?.color ?? '#888';
  const counts = new Map<string, { n: number; track: string }>();
  for (const e of c.events) {
    const x = counts.get(e.sliceId);
    counts.set(e.sliceId, { n: (x?.n ?? 0) + 1, track: x?.track ?? e.trackId });
  }
  const chops = [...counts.entries()].map(([sid, v]) => ({ s: slices.find((x) => x.id === sid)!, ...v })).filter((x) => x.s).sort((a, b) => b.n - a.n);
  const from = swapFrom ? slices.find((x) => x.id === swapFrom) : null;
  const usedTracks = c.tracks.filter((t) => c.events.some((e) => e.trackId === t.id));
  const setFx = (patch: Partial<typeof fx>) => st().setPrefs((d) => void (d.fx = { ...fx, ...patch }));
  return (
    <aside className="idea-panel" data-testid="idea-panel" style={{ '--c': style?.color ?? '#8f9bff' } as React.CSSProperties}>
      <div className="ip-head">
        <button className={`play-btn ${playing ? 'playing' : ''}`} data-testid="idea-play" onClick={() => toggleIdea(c.id)} title="Play / stop (Space)">{playing ? '■' : '▶'}</button>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <b className="ip-name" title={c.label}>{c.label}</b>
          <span className="dim small">{style ? `${style.icon} ${style.label}` : 'From the editor'}{c.score ? ` · hook check ${c.score.total}` : ''}</span>
        </div>
        <button className={`heart big ${c.favourite ? 'on' : ''}`} data-testid="idea-like" onClick={() => toggleLike(c.id)} title="Like (F)">♥</button>
      </div>

      <div className="drag-zone" draggable data-testid="idea-drag" onMouseEnter={() => void prepareDrag(c)} onDragStart={(e) => dragIdea(c, e)} title="Drag into your DAW">
        <b>⇱ Drag into your DAW</b>
        <span className="dim small">{isDesktop ? 'WAV at the session tempo – drop it on a track' : 'Browser build: drop onto your desktop or a folder, or use Save'}</span>
      </div>
      <div className="row tight">
        <button className="btn small" data-testid="idea-save" onClick={() => void quickExport(c)}>Save WAV</button>
        <button className="btn small" onClick={() => void saveIdeaStems(c.id)} title="One WAV per layer">Stems</button>
        <button className="btn small" onClick={() => void saveIdeaMidi(c.id)} title="MIDI + the chops as WAVs + a note map, for your sampler">MIDI + chops</button>
      </div>

      <div className="ip-section">
        <div className="ip-title">
          <span>Chops in this idea</span>
          <button className="btn small" data-testid="shuffle" onClick={() => { shuffleIdea(c.id); if (!st().playing) playIdea(c.id); }} title="Swap every chop for a similar one (S)">🔀 Shuffle chops</button>
        </div>
        <div className="chop-chips">
          {chops.map((x) => <ChopChip key={x.s.id} s={x.s} count={x.n} color={color(x.track)} active={swapFrom === x.s.id} onClick={() => setSwapFrom(swapFrom === x.s.id ? null : x.s.id)} />)}
        </div>
        {from && <SwapPicker idea={c} from={from} onSwapped={(to) => setSwapFrom(to)} />}
        {!from && <span className="dim small">Click a chop to swap it. Pitch and rhythm stay the same.</span>}
      </div>

      <div className="ip-section">
        <div className="ip-title"><span>Layers</span></div>
        <div className="layer-toggles">
          {usedTracks.map((t) => (
            <button key={t.id} className={`layer-toggle ${t.mute ? 'off' : ''}`} style={{ '--c': t.color } as React.CSSProperties} data-testid="layer-toggle" onClick={() => toggleLayer(c.id, t.id)} title={t.mute ? 'Muted – click to bring back' : 'Click to mute'}>
              <i />{t.name}
            </button>
          ))}
        </div>
      </div>

      <div className="ip-section">
        <div className="ip-title"><span>Shape</span></div>
        <div className="row tight" style={{ alignItems: 'center' }}>
          <span className="lbl" style={{ width: 52 }}>Pitch</span>
          <div className="seg">
            <button data-testid="pitch-down-oct" onClick={() => transposeIdeaBy(c.id, -12)} title="Octave down">−oct</button>
            <button onClick={() => transposeIdeaBy(c.id, -1)} title="Semitone down (leaves the key)">−1</button>
            <button onClick={() => transposeIdeaBy(c.id, 1)} title="Semitone up (leaves the key)">+1</button>
            <button data-testid="pitch-up-oct" onClick={() => transposeIdeaBy(c.id, 12)} title="Octave up">+oct</button>
          </div>
        </div>
        <label className="mini-row">
          <span>Swing</span>
          <input type="range" data-testid="idea-swing" min={0} max={0.7} step={0.01} value={c.groove?.swing ?? 0} onChange={(e) => setIdeaSwing(c.id, Number(e.target.value))} />
          <em>{Math.round((c.groove?.swing ?? 0) * 100)}</em>
        </label>
        <label className="mini-row" title="For listening. Exports stay dry unless “Print” is on in Pro ▸ Editor.">
          <span>Reverb</span>
          <input type="range" data-testid="studio-reverb" min={0} max={1} step={0.01} value={fx.reverb} onChange={(e) => setFx({ reverb: Number(e.target.value) })} />
          <em>{Math.round(fx.reverb * 100)}</em>
        </label>
        <label className="mini-row" title="Tempo-synced delay, for listening">
          <span>Delay</span>
          <input type="range" min={0} max={1} step={0.01} value={fx.delay} onChange={(e) => setFx({ delay: Number(e.target.value) })} />
          <em>{Math.round(fx.delay * 100)}</em>
        </label>
      </div>

      <div className="row tight" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary small" data-testid="idea-more" onClick={() => void moreLikeThis(c.id)}>↻ More like this</button>
        <button className="btn small" data-testid="idea-editor" onClick={() => openInEditor(c.id)} title="Edit note by note on the timeline (Pro)">✎ Edit on timeline</button>
        <button className="btn small ghost" onClick={() => deleteIdea(c.id)} title="Delete (Del)">🗑</button>
      </div>
      {c.score && (
        <div className="ip-why">
          <button className="link small" onClick={() => setWhy(!why)}>{why ? '▾' : '▸'} Why this idea works</button>
          {why && (
            <ul>
              {c.score.good.map((g, i) => <li key={`g${i}`} className="good">✓ {g}</li>)}
              {c.score.watch.map((g, i) => <li key={`w${i}`} className="watch">! {g}</li>)}
              {c.description.slice(1, 6).map((d, i) => <li key={i} className="dim">{d}</li>)}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

/* ───────────── chop pads ───────────── */

export const PAD_FILTERS: [string, string][] = [['notes', 'Notes'], ['syllables', 'Syllables'], ['words', 'Words'], ['all', 'All'], ['liked', '♥']];

export function padList(slices: Slice[], sources: SourceAudio[], filter: string, vocal?: string): Slice[] {
  const order = new Map(sources.map((s, i) => [s.id, i]));
  const okSrc = (s: Slice) => !vocal || vocal === 'all' || s.sourceId === vocal || sources.find((x) => x.id === s.sourceId)?.kind === 'derived';
  const list = slices.filter((s) => {
    if (!okSrc(s)) return false;
    if (filter === 'notes') return s.tags.includes('vowel') || s.tags.includes('sustained');
    if (filter === 'syllables') return s.level === 'syllable';
    if (filter === 'words') return s.level === 'word' || s.level === 'phrase';
    if (filter === 'liked') return s.favourite;
    return s.level !== 'phrase';
  });
  return list.sort((a, b) => (order.get(a.sourceId) ?? 0) - (order.get(b.sourceId) ?? 0) || a.start - b.start);
}

/** Slices sounding right now in the idea that is playing (to light up the pads). */
function useSounding(): Set<string> {
  const pos = useStore((s) => (s.playing ? Math.floor(s.positionTick / 60) : -1));
  const cand = useStore((s) => (s.playing ? s.doc.candidates.find((c) => c.id === s.ui.auditioning) : undefined));
  return useMemo(() => {
    const out = new Set<string>();
    if (!cand || pos < 0) return out;
    const t = pos * 60;
    for (const e of cand.events) if (t >= e.tick && t < e.tick + Math.min(e.length, 480)) out.add(e.sliceId);
    return out;
  }, [cand, pos]);
}

let currentPads: Slice[] = [];
export const padAt = (i: number) => currentPads[i];

function Pad({ s, n, lit }: { s: Slice; n: number; lit: boolean }) {
  const rt = useStore((x) => x.rt);
  const src = useStore((x) => x.doc.sources.find((y) => y.id === s.sourceId));
  const pitch = slicePitch(s, src);
  const color = s.tags.includes('sustained') ? '#5ee0c1' : s.tags.includes('vowel') ? '#8fd3ff' : s.level === 'syllable' ? '#ff8fc8' : s.level === 'word' ? '#ffb36b' : s.level === 'phrase' ? '#f5d76e' : '#c18fff';
  return (
    <div
      className={`pad ${lit ? 'lit' : ''}`}
      style={{ '--c': color } as React.CSSProperties}
      data-testid="pad"
      draggable
      onMouseEnter={() => void prepareSliceDrag(s.id)}
      onDragStart={(e) => dragSlice(s.id, e)}
      onMouseDown={(e) => e.button === 0 && auditionSlice(s.id)}
      title={`${s.name} – click to play${n < 10 ? ` (key ${(n + 1) % 10})` : ''} · drag into your DAW`}
    >
      {n < 10 && <kbd>{(n + 1) % 10}</kbd>}
      <button className={`pad-heart ${s.favourite ? 'on' : ''}`} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); actions.updateSlice(s.id, { favourite: !s.favourite }, 'Favourite'); }}>♥</button>
      <WaveThumb peaks={rt.peaks.get(s.sourceId)} data={rt.audio.get(s.sourceId)} start={s.start} end={s.end} height={26} color={color} />
      <span className="pad-name">{s.name}</span>
      <span className="pad-note">{pitch != null ? midiToName(Math.round(pitch)) : '·'}</span>
    </div>
  );
}

function PadBank({ pads }: { pads: Slice[] }) {
  const filter = useStore((s) => s.ui.padFilter ?? 'notes');
  const sounding = useSounding();
  currentPads = pads;
  return (
    <div className="pad-bank" data-testid="pad-bank">
      <div className="pb-head">
        <b>Chops</b>
        <div className="seg">
          {PAD_FILTERS.map(([v, l]) => (
            <button key={v} className={filter === v ? 'on' : ''} data-testid={`pads-${v}`} onClick={() => st().setUI({ padFilter: v })}>{l}</button>
          ))}
        </div>
        <span className="dim small">{pads.length} · click or keys 1–0 to play · drag a chop into your DAW</span>
        <button className="link small" style={{ marginLeft: 'auto' }} onClick={() => st().setUI({ view: 'slice' })}>Edit chops ▸</button>
      </div>
      <div className="pads">
        {pads.map((s, i) => <Pad key={s.id} s={s} n={i} lit={sounding.has(s.id)} />)}
        {!pads.length && <span className="dim small" style={{ padding: 10 }}>No chops in this group.</span>}
      </div>
    </div>
  );
}

/* ───────────── view ───────────── */

export function StudioView() {
  const hasVocal = useStore((s) => s.doc.sources.some((x) => x.kind !== 'derived'));
  const slices = useStore((s) => s.doc.slices);
  const sources = useStore((s) => s.doc.sources);
  const filter = useStore((s) => s.ui.padFilter ?? 'notes');
  const vocal = useStore((s) => s.ui.studioVocal);
  const pads = useMemo(() => {
    const p = padList(slices, sources, filter, vocal);
    // a vocal without detected vowels still gets a useful first view
    return p.length || filter !== 'notes' ? p : padList(slices, sources, 'syllables', vocal);
  }, [slices, sources, filter, vocal]);
  useEffect(() => () => void (currentPads = []), []);
  if (!hasVocal) return <div className="view studio"><StudioEmpty /></div>;
  return (
    <div className="view studio" data-testid="studio">
      <VocalStrip pads={pads} />
      <StyleBar />
      <div className="studio-main">
        <IdeaGrid />
        <IdeaPanel />
      </div>
      <PadBank pads={pads} />
    </div>
  );
}

export { stop as studioStop };
