import React, { useEffect, useRef } from 'react';
import type { AudioData } from '../../core/types';
import { buildPeaks, peaksForRange, type PeakPyramid } from '../../core/audio/peaks';

const cache = new WeakMap<AudioData, PeakPyramid>();

/** Small static waveform (uses the shared multi-resolution peak cache). */
export function WaveThumb({ data, peaks, start = 0, end, height = 34, color = '#8f9bff', reverse = false }: { data?: AudioData; peaks?: PeakPyramid; start?: number; end?: number; height?: number; color?: string; reverse?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let p = peaks;
    if (!p && data) {
      p = cache.get(data) ?? buildPeaks(data);
      cache.set(data, p);
    }
    if (!p) return;
    const w = (c.width = c.clientWidth * devicePixelRatio || 160);
    const h = (c.height = height * devicePixelRatio);
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    const e = end ?? p.frames;
    const { mins, maxs } = peaksForRange(p, start, e, w);
    g.fillStyle = color;
    let mx = 0;
    for (let i = 0; i < w; i++) mx = Math.max(mx, maxs[i], -mins[i]);
    const sc = mx > 0 ? 0.95 / mx : 1;
    for (let x = 0; x < w; x++) {
      const i = reverse ? w - 1 - x : x;
      const y0 = h / 2 - maxs[i] * sc * (h / 2);
      const y1 = h / 2 - mins[i] * sc * (h / 2);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [data, peaks, start, end, height, color, reverse]);
  return <canvas ref={ref} style={{ width: '100%', height }} />;
}
