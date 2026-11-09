import React from 'react';
import { Btn } from './ui';

const ROWS: [string, string][] = [
  ['Space', 'Play / stop'],
  ['Esc', 'Stop and return to start'],
  ['Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y)', 'Undo / redo'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'],
  ['Alt+1 … Alt+4', 'Switch workspace'],
  ['Slices: drag on waveform', 'Select a region'],
  ['Slices: double-click / M', 'Add a marker (drag markers to correct)'],
  ['Slices: Enter', 'Slice the selected region at the chosen level'],
  ['Slices: P / F / Delete', 'Play selection · favourite · delete slice'],
  ['Slices: wheel · Shift+wheel · Alt-drag', 'Zoom · scroll · scroll'],
  ['Timeline: click / Shift-click / Ctrl+A', 'Select events'],
  ['Timeline: drag · Alt-drag · Ctrl-drag', 'Move · duplicate · move without snap'],
  ['Timeline: drag right edge', 'Shorten the gate'],
  ['Timeline: Delete · R · L', 'Delete · reverse · lock'],
  ['Timeline: ↑ ↓ (Shift)', 'Transpose by semitone (octave) – playback rate'],
  ['Timeline: ← →', 'Nudge by one grid step'],
  ['Timeline: Ctrl+C / Ctrl+V / Ctrl+D', 'Copy · paste at playhead · duplicate'],
  ['Timeline: double-click a lane', 'Place the selected library slice'],
  ['Ruler: drag · click · 🔒', 'Select bars · seek · lock a bar'],
  ['Layer header: M S 🔒 R ↻', 'Mute · solo · lock layer · rhythm lock · regenerate layer'],
];

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" style={{ width: 640 }} onMouseDown={(e) => e.stopPropagation()} data-testid="help">
        <h2>Shortcuts & gestures</h2>
        <dl className="info-grid" style={{ gridTemplateColumns: '260px 1fr', rowGap: 6 }}>
          {ROWS.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt><kbd style={{ color: 'var(--text)' }}>{k}</kbd></dt>
              <dd style={{ fontFamily: 'var(--font)' }}>{v}</dd>
            </React.Fragment>
          ))}
        </dl>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Locks: events (L), bars (ruler 🔒), layers (🔒), rhythm (R), silences (◌ Lock silence) and important motifs are all respected by Generate, Variations and ↻ regeneration.
          Pitch changes use playback rate, so pitch and duration change together.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}><Btn onClick={onClose}>Close</Btn></div>
      </div>
    </div>
  );
}
