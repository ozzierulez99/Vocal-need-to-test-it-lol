import React, { useEffect, useState } from 'react';
import { platform, type Recent } from '../platform/platform';
import { Btn } from './ui';

/** Browser-mode replacement for the native "open project" dialog. */
export function ProjectPicker() {
  const [cb, setCb] = useState<((loc: string | null) => void) | null>(null);
  const [list, setList] = useState<Recent[]>([]);
  useEffect(() => {
    const h = (e: Event) => {
      const fn = (e as CustomEvent).detail as (l: string | null) => void;
      setCb(() => fn);
      void platform.recent().then(setList);
    };
    window.addEventListener('vcs:pick-project', h);
    return () => window.removeEventListener('vcs:pick-project', h);
  }, []);
  if (!cb) return null;
  const done = (l: string | null) => {
    cb(l);
    setCb(null);
  };
  return (
    <div className="modal-back" onMouseDown={() => done(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Open project</h2>
        <p className="muted" style={{ margin: 0 }}>Projects saved in this browser. (The desktop app saves real project folders on disk.)</p>
        {!list.length && <div className="empty">No saved projects yet.</div>}
        {list.map((r) => (
          <button key={r.location} className="example" data-testid={`open-${r.name}`} onClick={() => done(r.location)}>
            <b>{r.name}</b>
            <small>{r.location} {r.savedAt ? `· ${new Date(r.savedAt).toLocaleString()}` : ''}</small>
          </button>
        ))}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Btn onClick={() => done(null)}>Cancel</Btn>
        </div>
      </div>
    </div>
  );
}
