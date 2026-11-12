import React, { useState } from 'react';
import { useStore, actions } from '../store/store';
import type { Candidate, MotifProtection, Role, SeqEvent } from '../../core/types';
import { ROLES, PPQ } from '../../core/types';
import { GeneratorPanel } from '../components/GeneratorPanel';
import { Sequencer } from '../components/Sequencer';
import { Btn, Meter, NumberField, Section, Select, Slider, Toggle, Empty } from '../components/ui';
import { ticksPerBar, semitonesToRate } from '../../core/time';
import { applyCandidate, variationsOf, resliceSelection, generateIdeas, runInstant } from '../services/composeService';
import { keysSlice, keysBase, keysInScale, KEY_LABELS } from '../keys';
import { prepareDrag, startDrag, canDragOut, quickExport } from '../services/exportService';
import { audition, swapAB, stop, auditionSlice } from '../transport';
import { motifFromEvents } from '../../core/compose/motif';
import { uid } from '../../core/ids';

const GRIDS = [
  { value: 960, label: '1/4' },
  { value: 480, label: '1/8' },
  { value: 320, label: '1/8T' },
  { value: 240, label: '1/16' },
  { value: 160, label: '1/16T' },
  { value: 120, label: '1/32' },
];

function ComposeToolbar() {
  const seq = useStore((s) => s.doc.sequence);
  const ui = useStore((s) => s.ui);
  const setUI = useStore((s) => s.setUI);
  const [role, setRole] = useState<Role>('response');
  const bar = ticksPerBar(seq.timeSig);
  const lockRest = () => {
    if (!ui.bars) return useStore.getState().toast('Select bars in the ruler first', 'error');
    const [a, b] = ui.bars;
    useStore.getState().commit('Lock silence', (d) => {
      d.sequence.lockedRests.push({ id: uid('rest'), trackId: ui.trackId, startTick: a * bar, endTick: b * bar });
      // clear existing events that start inside the silence
      d.sequence.events = d.sequence.events.filter((e) => e.locked || !(e.tick >= a * bar && e.tick < b * bar && (ui.trackId === null || e.trackId === ui.trackId)));
    });
  };
  return (
    <div className="toolbar">
      <Select value={role} options={ROLES.map((r) => ({ value: r, label: r }))} onChange={setRole} />
      <Btn small testid="add-layer" onClick={() => actions.addTrack(role)}>＋ Layer</Btn>
      <span className="sep" />
      <span className="lbl">Grid</span>
      <Select testid="grid" value={seq.grid} options={GRIDS} onChange={(g) => actions.updateSeq({ grid: g }, 'Grid')} />
      <Toggle label="Snap" value={seq.snap} onChange={(v) => actions.updateSeq({ snap: v }, 'Snap')} title="Hold Ctrl while dragging for free placement" />
      <span className="lbl">Zoom</span>
      <input type="range" min={8} max={160} value={ui.pxPerBeat} onChange={(e) => setUI({ pxPerBeat: Number(e.target.value) })} style={{ width: 90 }} />
      <Btn small testid="zoom-fit" onClick={() => {
        const el = document.querySelector('[data-testid=sequencer]') as HTMLElement | null;
        const w = (el?.clientWidth ?? 900) - 240;
        setUI({ pxPerBeat: Math.max(8, Math.min(160, w / (seq.bars * seq.timeSig[0]))) });
      }}>Fit</Btn>
      <span className="sep" />
      <Btn small disabled={!ui.bars} testid="loop-selection" onClick={() => ui.bars && actions.updateSeq({ loop: { enabled: true, startTick: ui.bars[0] * bar, endTick: ui.bars[1] * bar } }, 'Loop selection')}>⟳ Loop bars</Btn>
      <Btn small onClick={() => actions.updateSeq({ loop: { enabled: seq.loop.enabled, startTick: 0, endTick: seq.bars * bar } }, 'Loop all')}>Loop all</Btn>
      <Btn small disabled={!ui.bars} testid="lock-bars" onClick={() => {
        if (!ui.bars) return;
        const [a, b] = ui.bars;
        const all = Array.from({ length: b - a }, (_, i) => a + i);
        const lock = !all.every((x) => seq.lockedBars.includes(x));
        useStore.getState().commit(lock ? 'Lock bars' : 'Unlock bars', (d) => {
          d.sequence.lockedBars = lock ? Array.from(new Set([...d.sequence.lockedBars, ...all])) : d.sequence.lockedBars.filter((x) => !all.includes(x));
        });
      }}>🔒 Bars</Btn>
      <Btn small disabled={!ui.bars} testid="lock-silence" onClick={lockRest} title="Turn the selected bars (on the selected layer, or all layers) into a protected silence">◌ Lock silence</Btn>
      <Btn small disabled={!ui.bars} onClick={() => setUI({ bars: null })}>Clear bar selection</Btn>
      <span className="sep" />
      <label className="mini-slider" title="Swing: delays every second sixteenth. Applied on playback and export, never baked into the events.">
        <span>Swing {Math.round((seq.groove?.swing ?? 0) * 100)}</span>
        <input data-testid="groove-swing" type="range" min={0} max={0.75} step={0.01} value={seq.groove?.swing ?? 0} onChange={(e) => actions.updateSeq({ groove: { swing: Number(e.target.value), humanize: seq.groove?.humanize ?? 0 } }, 'Swing')} />
      </label>
      <label className="mini-slider" title="Humanise: small, repeatable timing and level differences per chop">
        <span>Human {Math.round((seq.groove?.humanize ?? 0) * 100)}</span>
        <input data-testid="groove-human" type="range" min={0} max={1} step={0.01} value={seq.groove?.humanize ?? 0} onChange={(e) => actions.updateSeq({ groove: { swing: seq.groove?.swing ?? 0, humanize: Number(e.target.value) } }, 'Humanise')} />
      </label>
      <FxControls />
      <span className="sep" />
      <Btn small testid="keys-toggle" active={!!ui.keys} onClick={() => setUI({ keys: !ui.keys })} title="Play the selected chop from your computer keyboard like a sampler">🎹 Keys</Btn>
      {ui.keys && <Btn small testid="keys-rec" kind={ui.keysRecord ? 'danger' : undefined} active={!!ui.keysRecord} onClick={() => setUI({ keysRecord: !ui.keysRecord })} title="While playing, write what you play into the selected layer">● Rec</Btn>}
    </div>
  );
}

function KeysStrip() {
  const on = useStore((s) => s.ui.keys);
  useStore((s) => s.ui.sliceIds);
  useStore((s) => s.ui.eventIds);
  useStore((s) => s.doc.sequence.settings);
  if (!on) return null;
  const sl = keysSlice();
  const inScale = keysInScale();
  const black = [1, 3, 6, 8, 10];
  return (
    <div className="keys-strip" data-testid="keys-strip">
      <span className="lbl">Keys</span>
      <div className="keys">
        {KEY_LABELS.map((k, i) => <span key={k} className={`key ${black.includes(i % 12) ? 'black' : ''} ${inScale[i] ? 'in' : 'out'}`}>{k}</span>)}
      </div>
      <span className="dim" style={{ fontSize: 11 }}>
        {sl ? <>Playing <b>{sl.name}</b>{keysBase(sl).tuned ? ' · A = the key’s root, highlighted keys are in scale' : ' · A = original pitch (set a key to play in scale)'}</> : 'No slice yet'} · Z / X octave · pick another chop in the Library or click an event · ● Rec + ▶ writes into the selected layer
      </span>
    </div>
  );
}

function FxControls() {
  const fx = useStore((s) => s.doc.fx) ?? { reverb: 0, delay: 0, print: false };
  const set = (patch: Partial<typeof fx>) => useStore.getState().setPrefs((d) => void (d.fx = { ...fx, ...patch }));
  return (
    <>
      <span className="sep" />
      <label className="mini-slider" title="Audition reverb – hear the chops the way they will sit in your track. Exports stay dry unless “Print” is on.">
        <span>Reverb {Math.round(fx.reverb * 100)}</span>
        <input data-testid="fx-reverb" type="range" min={0} max={1} step={0.01} value={fx.reverb} onChange={(e) => set({ reverb: Number(e.target.value) })} />
      </label>
      <label className="mini-slider" title="Audition delay (dotted-eighth, tempo-synced)">
        <span>Delay {Math.round(fx.delay * 100)}</span>
        <input data-testid="fx-delay" type="range" min={0} max={1} step={0.01} value={fx.delay} onChange={(e) => set({ delay: Number(e.target.value) })} />
      </label>
      <Toggle label="Print" testid="fx-print" value={fx.print} onChange={(v) => set({ print: v })} title="Print the reverb/delay into exported mixes and dragged-out ideas (stems and slices always stay dry)" />
    </>
  );
}

function EventInspector() {
  const seq = useStore((s) => s.doc.sequence);
  const slices = useStore((s) => s.doc.slices);
  const sources = useStore((s) => s.doc.sources);
  const ids = useStore((s) => s.ui.eventIds);
  const evs = seq.events.filter((e) => ids.includes(e.id));
  if (!evs.length) return (
    <Section title="Event">
      <Empty>Select events in the timeline (Shift-click to add). Drag to move, drag the right edge to shorten, Alt-drag to duplicate. Keys: Del, R reverse, L lock, ↑↓ transpose, ←→ nudge, Ctrl+C/V/D.</Empty>
    </Section>
  );
  const e = evs[0];
  const upd = (fn: (x: SeqEvent) => void, label: string) => actions.updateEvents(ids, fn as any, label);
  const s = slices.find((x) => x.id === e.sliceId);
  const lenBeats = e.length / PPQ;
  const sr = sources.find((x) => x.id === s?.sourceId)?.sampleRate ?? 44100;
  return (
    <Section title={evs.length > 1 ? `${evs.length} events` : 'Event'} right={<Btn small kind="ghost" onClick={() => s && auditionSlice(s.id, { semitones: e.semitones, reverse: e.reverse })}>▶</Btn>}>
      <Select label="Slice" value={e.sliceId} options={slices.map((x) => ({ value: x.id, label: `${x.name} (${x.level})` }))} onChange={(v) => upd((x) => void (x.sliceId = v), 'Change slice')} />
      <Slider label="Gain" testid="ev-gain" value={e.gain} min={-36} max={6} step={0.5} format={(v) => `${v.toFixed(1)} dB`} onChange={(v) => upd((x) => void (x.gain = v), 'Gain')} />
      <Slider label="Transpose (playback rate)" value={e.semitones} min={-24} max={24} step={1} format={(v) => `${v > 0 ? '+' : ''}${v} st · ×${semitonesToRate(v).toFixed(2)}`} onChange={(v) => upd((x) => void (x.semitones = v), 'Transpose')} />
      <Slider label="Pan" value={e.pan} min={-1} max={1} step={0.05} format={(v) => (v === 0 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} onChange={(v) => upd((x) => void (x.pan = v), 'Pan')} />
      <div className="row">
        <NumberField label="Fade in" value={e.fadeIn} min={0} max={4000} suffix="ms" onChange={(v) => upd((x) => void (x.fadeIn = v), 'Fade in')} />
        <NumberField label="Fade out" value={e.fadeOut} min={0} max={4000} suffix="ms" onChange={(v) => upd((x) => void (x.fadeOut = v), 'Fade out')} />
      </div>
      <div className="row">
        <NumberField label="Gate" value={Math.round(lenBeats * 1000) / 1000} min={0.01} step={0.25} suffix="beats" onChange={(v) => upd((x) => void (x.length = Math.max(1, Math.round(v * PPQ))), 'Gate')} />
        <NumberField label="Start offset" value={Math.round((e.offset / sr) * 1000)} min={0} suffix="ms" onChange={(v) => upd((x) => void (x.offset = Math.round((v / 1000) * sr)), 'Offset')} />
      </div>
      <Slider label="Velocity (accent / MIDI)" value={e.velocity} onChange={(v) => upd((x) => void (x.velocity = v), 'Velocity')} />
      <div className="row">
        <NumberField label="Scoop from" value={e.glideIn?.[0] ?? 0} min={-24} max={24} suffix="st" onChange={(v) => upd((x) => void (x.glideIn = v ? [v, x.glideIn?.[1] ?? 60] : undefined), 'Scoop')} />
        <NumberField label="over" value={e.glideIn?.[1] ?? 60} min={5} max={2000} suffix="ms" onChange={(v) => upd((x) => void (x.glideIn = x.glideIn ? [x.glideIn[0], v] : undefined), 'Scoop time')} />
      </div>
      <div className="row">
        <NumberField label="Fall / rise to" value={e.glideOut?.[0] ?? 0} min={-36} max={24} suffix="st" onChange={(v) => upd((x) => void (x.glideOut = v ? [v, x.glideOut?.[1] ?? 200] : undefined), 'Pitch fall')} />
        <NumberField label="over last" value={e.glideOut?.[1] ?? 200} min={5} max={4000} suffix="ms" onChange={(v) => upd((x) => void (x.glideOut = x.glideOut ? [x.glideOut[0], v] : undefined), 'Fall time')} />
      </div>
      <div className="row">
        <Toggle label="Vowel on the grid" value={e.align !== false} onChange={(v) => upd((x) => void (x.align = v ? undefined : false), 'Onset alignment')} title="Starts the chop slightly early so its vowel (not its consonant) lands on the grid" />
        <Toggle label="Reverse" testid="ev-reverse" value={e.reverse} onChange={(v) => upd((x) => void (x.reverse = v), 'Reverse')} />
        <Toggle label="Locked" testid="ev-lock" value={e.locked} onChange={(v) => upd((x) => void (x.locked = v), 'Lock events')} />
      </div>
      {e.gesture && <span className="dim" style={{ fontSize: 11 }}>Generator intention: {e.gesture}{e.motifId ? ` · motif ${e.motifId}` : ''}</span>}
      <div className="row tight">
        <Btn small testid="make-motif" onClick={() => {
          const m = motifFromEvents(evs, uid('motif'), `Motif (${evs.length} events)`);
          if (!m) return;
          useStore.getState().commit('Define motif', (d) => {
            d.sequence.motifs = [m as any, ...d.sequence.motifs.map((x) => ({ ...x, important: false }))];
            for (const ev of d.sequence.events) if (ids.includes(ev.id)) ev.motifId = m.id;
          });
          useStore.getState().toast('Motif defined and marked important – regeneration will preserve it', 'success');
        }}>◆ Make motif</Btn>
        <Btn small onClick={() => resliceSelection()} title="Keep the rhythm, choose different slices with a similar role">Re-slice (keep rhythm)</Btn>
        <Btn small kind="danger" onClick={() => actions.removeEvents(ids)}>Delete</Btn>
      </div>
      <span className="dim" style={{ fontSize: 10.5 }}>Transposition is playback-rate based: pitch and duration change together.</span>
    </Section>
  );
}

function TrackInspector() {
  const t = useStore((s) => s.doc.sequence.tracks.find((x) => x.id === s.ui.trackId));
  if (!t) return null;
  return (
    <Section title={`Layer · ${t.name}`}>
      <Slider label="Layer gain" value={t.gain} min={-36} max={6} step={0.5} format={(v) => `${v.toFixed(1)} dB`} onChange={(v) => actions.updateTrack(t.id, { gain: v }, 'Layer gain')} />
      <Slider label="Layer pan" value={t.pan} min={-1} max={1} step={0.05} onChange={(v) => actions.updateTrack(t.id, { pan: v }, 'Layer pan')} format={(v) => v.toFixed(2)} />
      <div className="row">
        <Select label="Filter" value={t.filter?.type ?? 'off'} options={[{ value: 'off', label: 'off' }, { value: 'lowpass', label: 'low-pass' }, { value: 'highpass', label: 'high-pass' }]} onChange={(v) => actions.updateTrack(t.id, { filter: { type: v as any, frequency: t.filter?.frequency ?? (v === 'highpass' ? 300 : 3000) } }, 'Filter')} />
        {t.filter && t.filter.type !== 'off' && <NumberField label="Cutoff" value={t.filter.frequency} min={20} max={20000} suffix="Hz" onChange={(v) => actions.updateTrack(t.id, { filter: { ...t.filter!, frequency: v } }, 'Filter')} />}
      </div>
      <Toggle label="Choke (one voice, like a sampler)" testid="track-choke" value={!!t.choke} onChange={(v) => actions.updateTrack(t.id, { choke: v }, 'Choke')} title="A new chop cuts the previous one on this layer – tight, played-on-keys phrasing. Off: chops ring over each other." />
    </Section>
  );
}

function MotifPanel() {
  const motifs = useStore((s) => s.doc.sequence.motifs);
  const slices = useStore((s) => s.doc.slices);
  const commit = useStore((s) => s.commit);
  if (!motifs.length) return null;
  return (
    <Section title="Motifs">
      {motifs.map((m) => (
        <div key={m.id} className="collection" data-testid="motif">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <b style={{ fontSize: 12 }}>◆ {m.name}</b>
          </div>
          <span className="dim" style={{ fontSize: 11 }}>{m.notes.length} notes · {(m.span / PPQ).toFixed(1)} beats · {Array.from(new Set(m.notes.map((n) => slices.find((s) => s.id === n.sliceId)?.name ?? '?'))).join(', ')}</span>
          <div className="row">
            <Toggle label="Important" testid="motif-important" value={m.important} onChange={(v) => commit('Motif importance', (d) => void d.sequence.motifs.forEach((x) => (x.id === m.id ? (x.important = v) : v && (x.important = false))))} />
            <Select testid="motif-protection" value={m.protection} options={[
              { value: 'preserve', label: 'Preserve exactly' },
              { value: 'develop', label: 'Develop (keep its head)' },
              { value: 'transform', label: 'Transform substantially' },
              { value: 'replace', label: 'Replace entirely' },
            ] as { value: MotifProtection; label: string }[]} onChange={(v) => commit('Motif protection', (d) => void d.sequence.motifs.forEach((x) => x.id === m.id && (x.protection = v)))} />
          </div>
        </div>
      ))}
      <span className="dim" style={{ fontSize: 11 }}>An important motif steers every regeneration and variation according to its protection level.</span>
    </Section>
  );
}

function MiniTimeline({ c, bars, barTicks }: { c: Candidate; bars: number; barTicks: number }) {
  const total = bars * barTicks;
  const tracks = c.tracks;
  const h = 40;
  const rowH = h / Math.max(1, tracks.length);
  return (
    <svg className="mini" viewBox={`0 0 250 ${h}`} preserveAspectRatio="none">
      {c.events.map((e) => {
        const ti = Math.max(0, tracks.findIndex((t) => t.id === e.trackId));
        const t = tracks[ti];
        return <rect key={e.id} x={(e.tick / total) * 250} y={ti * rowH + 1} width={Math.max(1.2, (Math.min(e.length, barTicks / 2) / total) * 250)} height={Math.max(1, rowH - 2)} fill={t?.color ?? '#888'} opacity={0.85} />;
      })}
    </svg>
  );
}

function IdeaLab() {
  const cands = useStore((s) => s.doc.candidates);
  const ui = useStore((s) => s.ui);
  const bars = useStore((s) => s.doc.sequence.bars);
  const barT = useStore((s) => ticksPerBar(s.doc.sequence.timeSig));
  const playing = useStore((s) => s.playing);
  const setUI = useStore((s) => s.setUI);
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'kept'>('all');
  const list = cands.filter((c) => filter === 'all' || c.favourite).slice().reverse();
  return (
    <div className={`idea-lab ${collapsed ? 'collapsed' : ''}`} data-testid="idea-lab">
      <div className="idea-head">
        <h3>Idea Lab</h3>
        <span className="dim" style={{ fontSize: 11 }}>{cands.length} ideas</span>
        <Btn small kind="ghost" onClick={() => setFilter(filter === 'all' ? 'kept' : 'all')}>{filter === 'all' ? 'Show kept only' : 'Show all'}</Btn>
        <Btn small testid="ab-swap" disabled={!ui.candidateA || !ui.candidateB} onClick={() => swapAB()} title="Switch between A and B at the same position">A ⇄ B</Btn>
        <Btn small onClick={() => audition(null)} disabled={!ui.auditioning}>Back to arrangement</Btn>
        <Btn small testid="variations-current" onClick={() => variationsOf('current')}>Variations of arrangement</Btn>
        <Btn small kind="ghost" onClick={() => { cands.filter((c) => !c.favourite).forEach((c) => actions.removeCandidate(c.id)); }}>Clear unkept</Btn>
        <div className="spacer" />
        <Btn small kind="ghost" onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▴' : '▾'}</Btn>
      </div>
      {!collapsed && (
        <div className="cards">
          {!list.length && <Empty>Press <b>✦ Generate 6 ideas</b>. Each idea is composed with a different musical bias – melodic, rhythmic, hypnotic, spacious, fragmented, surprising – and labelled from what it actually contains. <Btn small onClick={() => generateIdeas(6)}>Generate now</Btn> <Btn small onClick={() => runInstant()}>⚡ Instant ideas</Btn></Empty>}
          {list.map((c) => {
            const isA = ui.candidateA === c.id;
            const isB = ui.candidateB === c.id;
            const isPlaying = playing && ui.auditioning === c.id;
            return (
              <div key={c.id} className={`card ${isA ? 'a' : ''} ${isB ? 'b' : ''} ${isPlaying ? 'playing' : ''}`} data-testid="candidate">
                <div className="card-title">
                  <b>{c.label}</b>
                  <span className="row tight">
                    {c.score && <span className={`score ${c.score.total >= 80 ? 'hi' : c.score.total >= 60 ? 'mid' : 'lo'}`} data-testid="score" title={`Hook check ${c.score.total}/100 · rhythm ${Math.round(c.score.parts.rhythm * 100)} · melody ${Math.round(c.score.parts.melody * 100)} · sound ${Math.round(c.score.parts.sound * 100)} · fit ${Math.round(c.score.parts.fit * 100)}`}>{c.score.total}</span>}
                    {isA && <span className="ab-tag a">A</span>}
                    {isB && <span className="ab-tag b">B</span>}
                    <button className={`star ${c.favourite ? 'on' : ''}`} data-testid="keep" title="Keep" onClick={() => actions.updateCandidate(c.id, { favourite: !c.favourite })}>★</button>
                  </span>
                </div>
                <MiniTimeline c={c} bars={bars} barTicks={barT} />
                <div className="why">{c.description[0]?.replace(`${c.label}: `, '')} · {c.settings.mode} / {c.settings.direction} · seed {c.settings.seed}</div>
                {c.score && (c.score.good[0] || c.score.watch[0]) && (
                  <div className="verdict">
                    {c.score.good[0] && <span className="good">✓ {c.score.good[0]}</span>}
                    {c.score.watch[0] && <span className="watch">! {c.score.watch[0]}</span>}
                  </div>
                )}
                <Meter label="density" value={c.metrics.density} />
                <Meter label="space" value={c.metrics.silence} />
                <Meter label="repetition" value={c.metrics.repetition} />
                <Meter label="melody" value={c.metrics.pitchSpread} />
                <Meter label="fragments" value={c.metrics.fragmentation} />
                <div className="actions">
                  <Btn small kind={isPlaying ? 'primary' : undefined} testid="audition" onClick={() => (isPlaying ? stop() : audition(c.id))}>{isPlaying ? '■' : '▶'}</Btn>
                  <Btn small active={isA} onClick={() => setUI({ candidateA: isA ? null : c.id })}>A</Btn>
                  <Btn small active={isB} onClick={() => setUI({ candidateB: isB ? null : c.id })}>B</Btn>
                  <Btn small kind="primary" testid="apply" onClick={() => { applyCandidate(c, 'all'); setUI({ auditioning: null }); }}>Apply</Btn>
                  <Btn small disabled={!ui.bars} onClick={() => applyCandidate(c, 'bars')} title="Take only the selected bars from this idea">Bars</Btn>
                  <Btn small onClick={() => applyCandidate(c, 'add-layers')} title="Add this idea's layers on top of the arrangement">+Layers</Btn>
                  <Btn small testid="variations" onClick={() => variationsOf(c)}>Vary</Btn>
                  <Btn small kind="ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Less' : 'Why?'}</Btn>
                  {canDragOut() ? (
                    <span className="btn small drag-out" data-testid="drag-out" draggable title="Drag this idea straight into your DAW (renders a WAV)" onMouseEnter={() => void prepareDrag(c)} onDragStart={(e) => { e.preventDefault(); startDrag(c); }}>⇱ Drag</span>
                  ) : null}
                  <Btn small testid="idea-wav" onClick={() => void quickExport(c)} title="Save this idea as a WAV without applying it">WAV</Btn>
                  <Btn small kind="ghost" onClick={() => actions.removeCandidate(c.id)} title="Discard">✕</Btn>
                </div>
                {open === c.id && (
                  <ul className="desc-list">
                    {c.score?.good.map((d, i) => <li key={`g${i}`} className="good">✓ {d}</li>)}
                    {c.score?.watch.map((d, i) => <li key={`w${i}`} className="watch">! {d}</li>)}
                    {c.description.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ComposeView() {
  return (
    <div className="view compose-view">
      <GeneratorPanel />
      <main className="compose-main main">
        <ComposeToolbar />
        <KeysStrip />
        <Sequencer />
        <IdeaLab />
      </main>
      <aside className="panel right">
        <EventInspector />
        <TrackInspector />
        <MotifPanel />
      </aside>
    </div>
  );
}
