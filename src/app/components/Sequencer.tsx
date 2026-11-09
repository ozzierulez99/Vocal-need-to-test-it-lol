import React, { useEffect, useMemo, useRef } from 'react';
import { useStore, actions } from '../store/store';
import type { Role, SeqEvent, Slice, SourceAudio, Track } from '../../core/types';
import { ROLES, PPQ } from '../../core/types';
import { ticksPerBar, ticksPerBeat, semitonesToRate, clamp } from '../../core/time';
import { seek } from '../transport';
import { uid } from '../../core/ids';
import { regenerateLayer } from '../services/composeService';

const HEAD = 210;
const LANE_H = 64;

export function naturalTicksOf(e: Pick<SeqEvent, 'offset' | 'semitones'>, s: Slice | undefined, src: SourceAudio | undefined, bpm: number) {
  if (!s || !src) return PPQ / 4;
  const sec = (s.end - s.start - e.offset) / src.sampleRate / semitonesToRate(e.semitones);
  return Math.max(1, Math.round((sec * bpm * PPQ) / 60));
}

let clipboard: { events: SeqEvent[]; span: number } | null = null;

function Playhead({ pxPerTick }: { pxPerTick: number }) {
  const tick = useStore((s) => s.positionTick);
  return <div className="playhead" style={{ left: HEAD + tick * pxPerTick }} />;
}

type Drag =
  | { kind: 'move'; x0: number; y0: number; orig: Map<string, { tick: number; track: number }>; free: boolean; moved: boolean }
  | { kind: 'gate'; id: string; x0: number; len0: number; max: number }
  | { kind: 'bars'; b0: number; moved: boolean; x0: number }
  | null;

export function Sequencer() {
  const seq = useStore((s) => s.doc.sequence);
  const slices = useStore((s) => s.doc.slices);
  const sources = useStore((s) => s.doc.sources);
  const ui = useStore((s) => s.ui);
  const setUI = useStore((s) => s.setUI);
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag>(null);

  const beat = ticksPerBeat(seq.timeSig);
  const bar = ticksPerBar(seq.timeSig);
  const total = seq.bars * bar;
  const pxPerTick = ui.pxPerBeat / beat;
  const width = total * pxPerTick;
  const sliceMap = useMemo(() => new Map(slices.map((s) => [s.id, s])), [slices]);
  const srcMap = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const trackIndex = useMemo(() => new Map(seq.tracks.map((t, i) => [t.id, i])), [seq.tracks]);
  const anySolo = seq.tracks.some((t) => t.solo);
  const snap = (t: number, free = false) => (seq.snap && !free ? Math.round(t / seq.grid) * seq.grid : Math.round(t));

  const selected = new Set(ui.eventIds);

  const localX = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return clientX - r.left + el.scrollLeft - HEAD;
  };

  const onEventDown = (e: React.MouseEvent, ev: SeqEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    let ids = ui.eventIds;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      ids = selected.has(ev.id) ? ids.filter((i) => i !== ev.id) : [...ids, ev.id];
      setUI({ eventIds: ids, trackId: ev.trackId });
      return;
    }
    if (!selected.has(ev.id)) ids = [ev.id];
    setUI({ eventIds: ids, trackId: ev.trackId });
    const st = useStore.getState();
    st.beginGesture();
    let moveIds = ids;
    if (e.altKey) {
      // alt-drag duplicates the selection
      const copies = st.doc.sequence.events.filter((x) => ids.includes(x.id)).map((x) => ({ ...x, id: uid('ev'), locked: false }));
      st.gesture((d) => void d.sequence.events.push(...copies));
      moveIds = copies.map((c) => c.id);
      setUI({ eventIds: moveIds });
    }
    const orig = new Map<string, { tick: number; track: number }>();
    for (const x of useStore.getState().doc.sequence.events) if (moveIds.includes(x.id)) orig.set(x.id, { tick: x.tick, track: trackIndex.get(x.trackId) ?? 0 });
    drag.current = { kind: 'move', x0: e.clientX, y0: e.clientY, orig, free: false, moved: false };
  };

  const onGateDown = (e: React.MouseEvent, ev: SeqEvent) => {
    e.stopPropagation();
    const s = sliceMap.get(ev.sliceId);
    const max = naturalTicksOf(ev, s, s ? srcMap.get(s.sourceId) : undefined, seq.bpm);
    setUI({ eventIds: [ev.id], trackId: ev.trackId });
    useStore.getState().beginGesture();
    drag.current = { kind: 'gate', id: ev.id, x0: e.clientX, len0: Math.min(ev.length, max), max };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.kind === 'move') {
        const dx = e.clientX - d.x0;
        const dy = e.clientY - d.y0;
        if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        d.moved = true;
        const free = e.ctrlKey || e.metaKey;
        const dTick = dx / pxPerTick;
        const dTrack = Math.round(dy / LANE_H);
        const tracks = useStore.getState().doc.sequence.tracks;
        useStore.getState().gesture((doc) => {
          for (const x of doc.sequence.events) {
            const o = d.orig.get(x.id);
            if (!o || x.locked) continue;
            const ti = clamp(o.track + dTrack, 0, tracks.length - 1);
            x.tick = clamp(snap(o.tick + dTick, free), 0, total - 1);
            x.trackId = tracks[ti].id;
          }
        });
      } else if (d.kind === 'gate') {
        const len = clamp(snap(d.len0 + (e.clientX - d.x0) / pxPerTick, e.ctrlKey || e.metaKey), Math.min(30, d.max), d.max);
        useStore.getState().gesture((doc) => {
          const x = doc.sequence.events.find((y) => y.id === d.id);
          if (x) x.length = len;
        });
      } else if (d.kind === 'bars') {
        const b = clamp(Math.floor(localX(e.clientX) / (bar * pxPerTick)), 0, seq.bars - 1);
        if (b !== d.b0 || Math.abs(e.clientX - d.x0) > 4) d.moved = true;
        if (d.moved) setUI({ bars: [Math.min(b, d.b0), Math.max(b, d.b0) + 1] });
      }
    };
    const up = (e: MouseEvent) => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.kind === 'move') {
        if (d.moved) {
          useStore.getState().gesture((doc) => void doc.sequence.events.sort((a, b) => a.tick - b.tick));
        }
        useStore.getState().endGesture(d.moved ? 'Move events' : 'Select');
      } else if (d.kind === 'gate') useStore.getState().endGesture('Resize event');
      else if (d.kind === 'bars' && !d.moved) {
        setUI({ bars: null });
        seek(clamp(snap(localX(e.clientX)), 0, total));
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });

  // keyboard editing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select')) return;
      const st = useStore.getState();
      const ids = st.ui.eventIds;
      const mod = e.ctrlKey || e.metaKey;
      const evs = st.doc.sequence.events;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ids.length) {
        e.preventDefault();
        actions.removeEvents(ids);
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setUI({ eventIds: evs.map((x) => x.id) });
      } else if (mod && e.key.toLowerCase() === 'c' && ids.length) {
        const sel = evs.filter((x) => ids.includes(x.id));
        const t0 = Math.min(...sel.map((x) => x.tick));
        const t1 = Math.max(...sel.map((x) => x.tick + x.length));
        clipboard = { events: sel.map((x) => ({ ...x, tick: x.tick - t0 })), span: Math.ceil((t1 - t0) / beat) * beat };
        st.toast(`Copied ${sel.length} event(s)`);
      } else if (mod && e.key.toLowerCase() === 'v' && clipboard) {
        e.preventDefault();
        const at = snap(st.positionTick);
        const oneTrack = new Set(clipboard.events.map((x) => x.trackId)).size === 1 && st.ui.trackId;
        const pasted = clipboard.events.map((x) => ({ ...x, id: uid('ev'), tick: x.tick + at, locked: false, trackId: oneTrack ? st.ui.trackId! : x.trackId })).filter((x) => x.tick < total);
        actions.addEvents(pasted);
      } else if (mod && e.key.toLowerCase() === 'd' && ids.length) {
        e.preventDefault();
        const sel = evs.filter((x) => ids.includes(x.id));
        const t0 = Math.min(...sel.map((x) => x.tick));
        const t1 = Math.max(...sel.map((x) => x.tick + x.length));
        const span = Math.max(beat, Math.ceil((t1 - t0) / beat) * beat);
        actions.addEvents(sel.map((x) => ({ ...x, id: uid('ev'), tick: x.tick + span, locked: false })).filter((x) => x.tick < total));
      } else if (e.key.toLowerCase() === 'r' && ids.length && !mod) actions.updateEvents(ids, (x) => void (x.reverse = !x.reverse), 'Reverse');
      else if (e.key.toLowerCase() === 'l' && ids.length && !mod) actions.updateEvents(ids, (x) => void (x.locked = !x.locked), 'Lock events');
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && ids.length) {
        e.preventDefault();
        const d = (e.key === 'ArrowLeft' ? -1 : 1) * seq.grid;
        actions.updateEvents(ids, (x) => void (!x.locked && (x.tick = clamp(x.tick + d, 0, total - 1))), 'Nudge');
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && ids.length) {
        e.preventDefault();
        const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
        actions.updateEvents(ids, (x) => void (x.semitones = clamp(x.semitones + d, -24, 24)), 'Transpose');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const addAt = (track: Track, clientX: number) => {
    const sliceId = ui.sliceIds[0];
    const s = sliceId ? sliceMap.get(sliceId) : undefined;
    if (!s) return useStore.getState().toast('Select a slice (Library or Slices view) first, then double-click a lane to place it.', 'error');
    const src = srcMap.get(s.sourceId);
    const tick = clamp(snap(localX(clientX)), 0, total - 1);
    const ev: SeqEvent = { id: uid('ev'), trackId: track.id, sliceId: s.id, tick, length: naturalTicksOf({ offset: 0, semitones: 0 }, s, src, seq.bpm), offset: 0, gain: -3, semitones: 0, reverse: false, fadeIn: 3, fadeOut: 10, pan: 0, velocity: 0.8, locked: false, role: track.role };
    actions.addEvents([ev]);
  };

  const grid: React.ReactNode[] = [];
  for (let b = 0; b < seq.bars; b++) {
    for (let k = 0; k < seq.timeSig[0]; k++) grid.push(<div key={`${b}-${k}`} className={`grid-line ${k === 0 ? 'bar' : ''}`} style={{ left: (b * bar + k * beat) * pxPerTick }} />);
  }

  return (
    <div className="seq" ref={scroller} data-testid="sequencer">
      <div className="seq-inner" style={{ width: HEAD + width + 40 }}>
        <div className="ruler">
          <div className="ruler-head">bars · drag to select · click to seek</div>
          <div
            className="ruler-lane"
            data-testid="ruler"
            style={{ width }}
            onMouseDown={(e) => {
              const b = clamp(Math.floor(localX(e.clientX) / (bar * pxPerTick)), 0, seq.bars - 1);
              drag.current = { kind: 'bars', b0: b, moved: false, x0: e.clientX };
            }}
          >
            {Array.from({ length: seq.bars }, (_, b) => (
              <div key={b} className="bar-num" style={{ left: b * bar * pxPerTick, width: bar * pxPerTick }}>
                {b + 1}
                <span className={`lock ${seq.lockedBars.includes(b) ? 'on' : ''}`} data-testid={`lock-bar-${b}`} title="Lock this bar (kept during regeneration)" onMouseDown={(e) => { e.stopPropagation(); actions.toggleBarLock(b); }}>🔒</span>
              </div>
            ))}
            {seq.loop.enabled && <div className="loop-band" style={{ left: seq.loop.startTick * pxPerTick, width: (seq.loop.endTick - seq.loop.startTick) * pxPerTick }} />}
            {ui.bars && <div className="bar-sel" data-testid="bar-selection" style={{ left: ui.bars[0] * bar * pxPerTick, width: (ui.bars[1] - ui.bars[0]) * bar * pxPerTick }} />}
          </div>
        </div>
        {seq.tracks.map((t) => {
          const audible = anySolo ? t.solo : !t.mute;
          return (
            <div className="track-row" key={t.id} data-testid={`track-${t.name}`}>
              <div className={`track-head ${ui.trackId === t.id ? 'sel' : ''}`} onMouseDown={() => setUI({ trackId: ui.trackId === t.id ? null : t.id })}>
                <div className="name-row">
                  <span className="swatch" style={{ background: t.color }} />
                  <input className="tname" value={t.name} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => actions.updateTrack(t.id, { name: e.target.value }, 'Rename layer')} onKeyDown={(e) => e.stopPropagation()} />
                </div>
                <div className="name-row" onMouseDown={(e) => e.stopPropagation()}>
                  <select value={t.role} title="Musical role of this layer" onChange={(e) => actions.updateTrack(t.id, { role: e.target.value as Role })}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button className={`tbtn m ${t.mute ? 'on' : ''}`} data-testid={`mute-${t.name}`} title="Mute" onClick={() => actions.updateTrack(t.id, { mute: !t.mute }, 'Mute')}>M</button>
                  <button className={`tbtn s ${t.solo ? 'on' : ''}`} data-testid={`solo-${t.name}`} title="Solo" onClick={() => actions.updateTrack(t.id, { solo: !t.solo }, 'Solo')}>S</button>
                  <button className={`tbtn l ${t.locked ? 'on' : ''}`} data-testid={`lock-${t.name}`} title="Lock layer (regeneration keeps it)" onClick={() => actions.updateTrack(t.id, { locked: !t.locked }, 'Lock layer')}>🔒</button>
                  <button className="tbtn" title="Regenerate only this layer" onClick={() => regenerateLayer(t.id)}>↻</button>
                  <button className="tbtn" title="Delete layer" onClick={() => window.confirm(`Delete layer “${t.name}” and its events?`) && actions.removeTrack(t.id)}>✕</button>
                </div>
              </div>
              <div className="lane" style={{ width }} onMouseDown={(e) => { if (e.target === e.currentTarget) setUI({ eventIds: [], trackId: t.id }); }} onDoubleClick={(e) => addAt(t, e.clientX)}>
                {grid}
                {seq.lockedBars.map((b) => <div key={`lb${b}`} className="locked-bar" style={{ left: b * bar * pxPerTick, width: bar * pxPerTick }} />)}
                {seq.lockedRests.filter((r) => r.trackId === null || r.trackId === t.id).map((r) => (
                  <div key={r.id} className="rest" style={{ left: r.startTick * pxPerTick, width: (r.endTick - r.startTick) * pxPerTick }} title="Locked silence – generators never fill it">
                    silence
                    <button onMouseDown={(e) => e.stopPropagation()} onClick={() => useStore.getState().commit('Remove locked silence', (d) => void (d.sequence.lockedRests = d.sequence.lockedRests.filter((x) => x.id !== r.id)))}>✕</button>
                  </div>
                ))}
                {seq.events.filter((e) => e.trackId === t.id).map((ev) => {
                  const s = sliceMap.get(ev.sliceId);
                  const src = s ? srcMap.get(s.sourceId) : undefined;
                  const nat = naturalTicksOf(ev, s, src, seq.bpm);
                  const play = Math.min(ev.length, nat);
                  const missing = !s || !src || src.missing;
                  return (
                    <div
                      key={ev.id}
                      data-testid="event"
                      data-event-id={ev.id}
                      className={`ev ${selected.has(ev.id) ? 'sel' : ''} ${ev.locked ? 'locked' : ''} ${!audible ? 'muted' : ''} ${ev.motifId ? 'motif' : ''}`}
                      style={{ left: ev.tick * pxPerTick, width: Math.max(4, play * pxPerTick - 1), background: missing ? '#555' : t.color, opacity: 0.55 + Math.min(1, Math.max(0, ev.velocity)) * 0.45 }}
                      title={`${s?.name ?? 'missing slice'} · ${ev.semitones ? `${ev.semitones > 0 ? '+' : ''}${ev.semitones} st · ` : ''}${ev.gain.toFixed(1)} dB${ev.reverse ? ' · reversed' : ''}${ev.gesture ? ` · ${ev.gesture}` : ''}`}
                      onMouseDown={(e) => onEventDown(e, ev)}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <span className="ev-name">{s?.name ?? '?'}</span>
                      <span className="ev-icons">
                        {ev.reverse && <span>◀</span>}
                        {ev.semitones !== 0 && <span>{ev.semitones > 0 ? '+' : ''}{Math.round(ev.semitones * 10) / 10}</span>}
                        {ev.locked && <span>🔒</span>}
                        {ev.offset > 0 && <span>✂</span>}
                      </span>
                      <span className="gate" onMouseDown={(e) => onGateDown(e, ev)} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <Playhead pxPerTick={pxPerTick} />
        {!seq.events.length && (
          <div className="seq-empty empty">
            The arrangement is empty. Choose a mode on the left and press <b>Generate 6 ideas</b> – or double-click a lane to place the selected slice by hand.
          </div>
        )}
      </div>
    </div>
  );
}
