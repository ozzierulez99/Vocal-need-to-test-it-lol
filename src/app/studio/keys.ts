import { useStore } from '../store/store';
import { auditionSlice, stop } from '../transport';
import { playIdea, stepIdea, toggleLike, moreLikeThis, shuffleIdea, deleteIdea, undoIdeaEdit, visibleIdeas } from '../services/studioService';
import { padAt } from '../views/StudioView';

/** Studio shortcuts. Returns true when the key was handled. */
export function handleStudioKey(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  if (s.ui.view !== 'studio' || e.altKey) return false;
  const mod = e.ctrlKey || e.metaKey;
  const id = s.ui.idea ?? visibleIdeas()[0]?.id;
  if (mod) {
    if (e.key.toLowerCase() === 'z' && !e.shiftKey) return undoIdeaEdit();
    return false;
  }
  if (e.code === 'Space') {
    // a focused button would also "click" on key-up
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
    if (s.playing) stop();
    else if (id) playIdea(id);
    return true;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return stepIdea(1), true;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return stepIdea(-1), true;
  if (/^[0-9]$/.test(e.key)) {
    const pad = padAt((Number(e.key) + 9) % 10);
    if (pad) auditionSlice(pad.id);
    return !!pad;
  }
  if (!id) return false;
  const k = e.key.toLowerCase();
  if (k === 'f') return toggleLike(id), true;
  if (k === 'v') return void moreLikeThis(id), true;
  if (k === 's') return shuffleIdea(id), true;
  if (e.key === 'Delete' || e.key === 'Backspace') return deleteIdea(id), true;
  return false;
}
