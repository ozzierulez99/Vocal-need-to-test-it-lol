import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, actions } from '../src/app/store/store';
import { newProjectDoc } from '../src/core/project/project';
import { demoProject } from './helpers';

function reset() {
  const { sources, slices, audio } = demoProject();
  const doc = newProjectDoc('t');
  doc.sources = sources.map((s) => ({ ...s }));
  doc.slices = slices.slice(0, 10).map((s) => ({ ...s }));
  useStore.getState().loadDoc(doc, new Map(audio), new Map(), null);
}

describe('undo / redo', () => {
  beforeEach(reset);
  it('undoes and redoes slice edits', () => {
    const s0 = useStore.getState().doc.slices[0];
    actions.updateSlice(s0.id, { name: 'renamed' });
    actions.updateSlice(s0.id, { favourite: true });
    expect(useStore.getState().doc.slices[0]).toMatchObject({ name: 'renamed', favourite: true });
    useStore.getState().undo();
    expect(useStore.getState().doc.slices[0].favourite).toBe(false);
    useStore.getState().undo();
    expect(useStore.getState().doc.slices[0].name).toBe(s0.name);
    useStore.getState().redo();
    expect(useStore.getState().doc.slices[0].name).toBe('renamed');
  });
  it('a new edit clears the redo stack', () => {
    const id = useStore.getState().doc.slices[0].id;
    actions.updateSlice(id, { name: 'a' });
    useStore.getState().undo();
    actions.updateSlice(id, { name: 'b' });
    expect(useStore.getState().future.length).toBe(0);
  });
  it('drag gestures become a single undo step', () => {
    const id = useStore.getState().doc.slices[0].id;
    const start = useStore.getState().doc.slices[0].start;
    const st = useStore.getState();
    st.beginGesture();
    for (let i = 1; i <= 10; i++) st.gesture((d) => void (d.slices[0].start = start + i * 10));
    st.endGesture('drag');
    expect(useStore.getState().doc.slices[0].start).toBe(start + 100);
    useStore.getState().undo();
    expect(useStore.getState().doc.slices[0].start).toBe(start);
  });
  it('deleting slices removes dependent events, undo restores both', () => {
    const id = useStore.getState().doc.slices[0].id;
    actions.addEvents([{ id: 'e1', trackId: 'trk-lead', sliceId: id, tick: 0, length: 960, offset: 0, gain: 0, semitones: 0, reverse: false, fadeIn: 0, fadeOut: 0, pan: 0, velocity: 0.8, locked: false }]);
    actions.removeSlices([id]);
    expect(useStore.getState().doc.sequence.events.length).toBe(0);
    useStore.getState().undo();
    expect(useStore.getState().doc.sequence.events.length).toBe(1);
    expect(useStore.getState().doc.slices.some((s) => s.id === id)).toBe(true);
  });
  it('generator preferences and candidates are not rolled back by undo', () => {
    actions.updateSeq({ bpm: 99 });
    actions.setSettings({ seed: 4242 });
    useStore.getState().undo();
    expect(useStore.getState().doc.sequence.bpm).toBe(140);
    expect(useStore.getState().doc.sequence.settings.seed).toBe(4242);
  });
});
