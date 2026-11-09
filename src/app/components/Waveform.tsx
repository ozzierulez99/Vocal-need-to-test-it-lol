import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Slice, SliceLevel, SourceAudio } from '../../core/types';
import { SLICE_LEVELS } from '../../core/types';
import { peaksForRange, type PeakPyramid } from '../../core/audio/peaks';
import { MIN_SLICE_FRAMES } from '../../core/slicing/slices';
import { engine } from '../audio/engine';

export interface Region {
  start: number;
  end: number;
}

const RULER = 20;
const WAVE = 180;
const LANE = 26;
const LEVEL_COLORS: Record<SliceLevel, string> = { phrase: '#b48cff', word: '#ff6fa8', syllable: '#5ee0c1', sound: '#ffc861' };

interface Props {
  source: SourceAudio;
  peaks: PeakPyramid | undefined;
  slices: Slice[];
  selected: string[];
  markers: number[];
  region: Region | null;
  cursor: number;
  onRegion: (r: Region | null) => void;
  onCursor: (f: number) => void;
  onMarkers: (m: number[]) => void;
  onSelect: (ids: string[], additive: boolean) => void;
  onEdgeDragStart: () => void;
  onEdgeDrag: (id: string, patch: { start?: number; end?: number }) => void;
  onEdgeDragEnd: (id: string, moved: boolean) => void;
  onAudition: (s: Slice) => void;
  zoomCmd: { n: number; kind: 'in' | 'out' | 'fit' | 'region' } | null;
}

type Drag =
  | { kind: 'region'; anchor: number; moved: boolean }
  | { kind: 'marker'; index: number }
  | { kind: 'edge'; id: string; edge: 'start' | 'end'; min: number; max: number; moved: boolean }
  | { kind: 'pan'; x: number; start: number }
  | null;

export function Waveform(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(900);
  const [view, setView] = useState({ start: 0, fpp: Math.max(1, p.source.frames / 900) });
  const drag = useRef<Drag>(null);
  const [hover, setHover] = useState<string>('');
  const [, force] = useState(0);
  const height = RULER + WAVE + LANE * SLICE_LEVELS.length + 6;

  // fit when source changes
  useEffect(() => {
    setView({ start: 0, fpp: Math.max(0.05, p.source.frames / Math.max(100, width)) });
  }, [p.source.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clampView = useCallback(
    (v: { start: number; fpp: number }) => {
      const fpp = Math.min(Math.max(0.05, v.fpp), Math.max(1, p.source.frames / width) * 1.02);
      const start = Math.min(Math.max(0, v.start), Math.max(0, p.source.frames - fpp * width));
      return { start, fpp };
    },
    [p.source.frames, width],
  );

  useEffect(() => {
    const z = p.zoomCmd;
    if (!z) return;
    setView((v) => {
      const mid = v.start + (v.fpp * width) / 2;
      if (z.kind === 'fit') return clampView({ start: 0, fpp: p.source.frames / width });
      if (z.kind === 'region' && p.region) return clampView({ start: p.region.start - (p.region.end - p.region.start) * 0.1, fpp: ((p.region.end - p.region.start) * 1.2) / width });
      const fpp = z.kind === 'in' ? v.fpp / 1.6 : v.fpp * 1.6;
      return clampView({ start: mid - (fpp * width) / 2, fpp });
    });
  }, [p.zoomCmd]); // eslint-disable-line react-hooks/exhaustive-deps

  const xOf = (f: number) => (f - view.start) / view.fpp;
  const fOf = (x: number) => Math.round(Math.max(0, Math.min(p.source.frames, view.start + x * view.fpp)));

  // draw
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0b0c10';
    g.fillRect(0, 0, width, height);
    const sr = p.source.sampleRate;
    // ruler
    g.fillStyle = '#13151b';
    g.fillRect(0, 0, width, RULER);
    const secPerPx = view.fpp / sr;
    const steps = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
    const step = steps.find((s) => s / secPerPx > 70) ?? 60;
    g.font = '10px ui-monospace, monospace';
    g.fillStyle = '#8b93a5';
    g.strokeStyle = '#262b35';
    const t0 = view.start / sr;
    for (let t = Math.ceil(t0 / step) * step; t < t0 + width * secPerPx; t += step) {
      const x = xOf(t * sr);
      g.fillRect(x, RULER - 6, 1, 6);
      g.fillText(step < 0.1 ? `${(t * 1000).toFixed(0)}ms` : `${t.toFixed(step < 1 ? 2 : 0)}s`, x + 3, 12);
    }
    // beat grid if bpm known
    if (p.source.bpm) {
      const beat = (60 / p.source.bpm) * sr;
      g.fillStyle = '#ffffff08';
      for (let f = Math.ceil(view.start / beat) * beat; f < view.start + width * view.fpp; f += beat) g.fillRect(xOf(f), RULER, 1, WAVE);
    }
    // waveform
    const mid = RULER + WAVE / 2;
    if (p.peaks && !p.source.missing) {
      const { mins, maxs } = peaksForRange(p.peaks, view.start, view.start + width * view.fpp, width);
      g.fillStyle = '#3a4258';
      g.fillRect(0, mid, width, 1);
      const grad = g.createLinearGradient(0, RULER, 0, RULER + WAVE);
      grad.addColorStop(0, '#8f9bff');
      grad.addColorStop(0.5, '#c7a4ff');
      grad.addColorStop(1, '#8f9bff');
      g.fillStyle = grad;
      for (let x = 0; x < width; x++) {
        const y0 = mid - maxs[x] * (WAVE / 2 - 4);
        const y1 = mid - mins[x] * (WAVE / 2 - 4);
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    } else {
      g.fillStyle = '#ff6b6b';
      g.fillText('Source audio missing – use Relink in the source panel', 12, mid);
    }
    // region
    if (p.region) {
      const a = xOf(p.region.start);
      const b = xOf(p.region.end);
      g.fillStyle = '#5ee0c122';
      g.fillRect(a, RULER, b - a, WAVE);
      g.fillStyle = '#5ee0c1';
      g.fillRect(a, RULER, 1, WAVE);
      g.fillRect(b, RULER, 1, WAVE);
    }
    // selected slice highlight on wave
    for (const s of p.slices) {
      if (!p.selected.includes(s.id)) continue;
      g.fillStyle = `${LEVEL_COLORS[s.level]}18`;
      g.fillRect(xOf(s.start), RULER, xOf(s.end) - xOf(s.start), WAVE);
    }
    // markers
    g.fillStyle = '#ffc861';
    for (const m of p.markers) {
      const x = xOf(m);
      if (x < -2 || x > width + 2) continue;
      g.fillRect(x, RULER, 1, WAVE + LANE * 4);
      g.beginPath();
      g.moveTo(x - 4, RULER);
      g.lineTo(x + 4, RULER);
      g.lineTo(x, RULER + 6);
      g.fill();
    }
    // cursor
    g.fillStyle = '#ffffff';
    g.fillRect(xOf(p.cursor), RULER, 1, WAVE);
    // lanes
    SLICE_LEVELS.forEach((lvl, i) => {
      const y = RULER + WAVE + 4 + i * LANE;
      g.fillStyle = i % 2 ? '#101217' : '#0e1015';
      g.fillRect(0, y, width, LANE);
      for (const s of p.slices.filter((x) => x.level === lvl)) {
        const a = xOf(s.start);
        const b = xOf(s.end);
        if (b < 0 || a > width) continue;
        const sel = p.selected.includes(s.id);
        g.fillStyle = sel ? LEVEL_COLORS[lvl] : `${LEVEL_COLORS[lvl]}55`;
        g.fillRect(a + 0.5, y + 3, Math.max(2, b - a - 1), LANE - 6);
        g.fillStyle = sel ? '#0b0c10' : '#e6e8ee';
        g.font = '600 10.5px system-ui';
        if (b - a > 24) g.fillText(`${s.favourite ? '★ ' : ''}${s.name}`, a + 4, y + 16, b - a - 6);
        if (sel) {
          g.fillStyle = '#fff';
          g.fillRect(a, y + 3, 2, LANE - 6);
          g.fillRect(b - 2, y + 3, 2, LANE - 6);
        }
      }
    });
    // lane labels on top of the slices
    SLICE_LEVELS.forEach((lvl, i) => {
      const y = RULER + WAVE + 4 + i * LANE;
      g.font = '600 9px system-ui';
      const w = g.measureText(lvl.toUpperCase()).width + 8;
      g.fillStyle = '#0b0c10cc';
      g.fillRect(width - w - 4, y + 6, w, 14);
      g.fillStyle = '#8b93a5';
      g.fillText(lvl.toUpperCase(), width - w, y + 16.5);
    });
    // audition cursor
    const ai = engine.auditionInfo;
    if (ai && ai.sourceId === p.source.id && engine.ctx) {
      const el = engine.ctx.currentTime - ai.t0;
      if (el >= 0 && el <= ai.dur) {
        const f = ai.reverse ? ai.end - el * ai.rate * sr : ai.start + el * ai.rate * sr;
        g.fillStyle = '#5ee0c1';
        g.fillRect(xOf(f), RULER, 2, WAVE);
      }
    }
  });

  // animate while auditioning
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const ai = engine.auditionInfo;
      if (ai && engine.ctx && engine.ctx.currentTime - ai.t0 <= ai.dur + 0.05) force((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const laneAt = (y: number): SliceLevel | null => {
    const i = Math.floor((y - RULER - WAVE - 4) / LANE);
    return i >= 0 && i < SLICE_LEVELS.length ? SLICE_LEVELS[i] : null;
  };
  const hit = (x: number, y: number) => {
    const lvl = laneAt(y);
    if (!lvl) return null;
    const cands = p.slices.filter((s) => s.level === lvl && xOf(s.start) - 5 <= x && xOf(s.end) + 5 >= x);
    // prefer edges of selected slices, then smallest slice
    for (const s of cands) {
      if (Math.abs(xOf(s.start) - x) <= 5) return { s, edge: 'start' as const };
      if (Math.abs(xOf(s.end) - x) <= 5) return { s, edge: 'end' as const };
    }
    const inside = cands.filter((s) => xOf(s.start) <= x && xOf(s.end) >= x).sort((a, b) => a.end - a.start - (b.end - b.start));
    return inside[0] ? { s: inside[0], edge: null } : null;
  };

  const onDown = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      drag.current = { kind: 'pan', x, start: view.start };
      return;
    }
    if (y < RULER + WAVE) {
      const mi = p.markers.findIndex((m) => Math.abs(xOf(m) - x) <= 4);
      if (mi >= 0) {
        drag.current = { kind: 'marker', index: mi };
        return;
      }
      const f = fOf(x);
      drag.current = { kind: 'region', anchor: f, moved: false };
      return;
    }
    const h = hit(x, y);
    if (!h) {
      if (!e.shiftKey) p.onSelect([], false);
      return;
    }
    if (h.edge && (p.selected.includes(h.s.id) || true)) {
      const siblings = p.slices.filter((s) => s.level === h.s.level && s.id !== h.s.id && s.parentId === h.s.parentId);
      const parent = p.slices.find((s) => s.id === h.s.parentId);
      let min = parent ? parent.start : 0;
      let max = parent ? parent.end : p.source.frames;
      // do not drag through adjacent siblings (keeps lanes tidy)
      for (const s of siblings) {
        if (h.edge === 'start' && s.end <= h.s.start + 2) min = Math.max(min, s.end);
        if (h.edge === 'end' && s.start >= h.s.end - 2) max = Math.min(max, s.start);
      }
      p.onSelect([h.s.id], false);
      p.onEdgeDragStart();
      drag.current = { kind: 'edge', id: h.s.id, edge: h.edge, min, max, moved: false };
      return;
    }
    p.onSelect([h.s.id], e.shiftKey || e.metaKey || e.ctrlKey);
    p.onRegion({ start: h.s.start, end: h.s.end });
    if (!e.shiftKey) p.onAudition(h.s);
  };

  const onMove = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const d = drag.current;
    if (!d) {
      const h = y >= RULER + WAVE ? hit(x, y) : null;
      setHover(h?.edge ? 'ew-resize' : h ? 'pointer' : y < RULER + WAVE && p.markers.some((m) => Math.abs(xOf(m) - x) <= 4) ? 'ew-resize' : 'crosshair');
      return;
    }
    const f = fOf(x);
    if (d.kind === 'pan') setView(clampView({ start: d.start - (x - d.x) * view.fpp, fpp: view.fpp }));
    else if (d.kind === 'region') {
      if (Math.abs(f - d.anchor) > view.fpp * 3) d.moved = true;
      if (d.moved) p.onRegion({ start: Math.min(f, d.anchor), end: Math.max(f, d.anchor) });
    } else if (d.kind === 'marker') {
      const m = p.markers.slice();
      m[d.index] = f;
      p.onMarkers(m);
    } else if (d.kind === 'edge') {
      const s = p.slices.find((x) => x.id === d.id);
      if (!s) return;
      d.moved = true;
      if (d.edge === 'start') p.onEdgeDrag(d.id, { start: Math.max(d.min, Math.min(f, s.end - MIN_SLICE_FRAMES)) });
      else p.onEdgeDrag(d.id, { end: Math.min(d.max, Math.max(f, s.start + MIN_SLICE_FRAMES)) });
    }
  };

  const onUp = (e: React.MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'region' && !d.moved) {
      const r = canvas.current!.getBoundingClientRect();
      p.onCursor(fOf(e.clientX - r.left));
      p.onRegion(null);
    }
    if (d.kind === 'marker') p.onMarkers(p.markers.slice().sort((a, b) => a - b));
    if (d.kind === 'edge') p.onEdgeDragEnd(d.id, d.moved);
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      setView(clampView({ start: view.start + (e.deltaX || e.deltaY) * view.fpp, fpp: view.fpp }));
      return;
    }
    const f = view.start + x * view.fpp;
    const fpp = view.fpp * Math.pow(1.0015, e.deltaY);
    setView(clampView({ start: f - x * fpp, fpp }));
  };

  const onDouble = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (y < RULER + WAVE) p.onMarkers([...p.markers, fOf(e.clientX - r.left)].sort((a, b) => a - b));
  };

  const scrollMax = Math.max(0, p.source.frames - view.fpp * width);
  return (
    <div ref={wrap} className="wave-box" style={{ position: 'relative' }}>
      <canvas
        ref={canvas}
        data-testid="waveform"
        className="wave-canvas"
        style={{ height, cursor: hover || 'crosshair' }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={(e) => drag.current && onUp(e)}
        onWheel={onWheel}
        onDoubleClick={onDouble}
      />
      {scrollMax > 0 && (
        <input
          type="range"
          aria-label="scroll"
          min={0}
          max={scrollMax}
          step={view.fpp}
          value={view.start}
          onChange={(e) => setView(clampView({ start: Number(e.target.value), fpp: view.fpp }))}
          style={{ width: '100%' }}
        />
      )}
      <div className="wave-help">
        Drag on the waveform to select a region · double-click to add a marker · drag markers & slice edges · wheel = zoom, Shift+wheel or Alt-drag = scroll ·
        {' '}view {((view.fpp * width) / p.source.sampleRate).toFixed(2)} s
      </div>
    </div>
  );
}
