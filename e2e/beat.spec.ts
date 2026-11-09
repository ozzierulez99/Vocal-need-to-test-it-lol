import { test, expect } from '@playwright/test';
import { fresh, state, importWav } from './helpers';
import { demoBeatFile } from '../src/core/demo/beats';

async function dropFile(page: any, name: string, bytes: Uint8Array, mime = 'audio/midi') {
  await page.evaluate(
    ({ name, data, mime }: { name: string; data: number[]; mime: string }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(data)], name, { type: mime }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { name, data: Array.from(bytes), mime },
  );
}

test.describe('Fit to my beat', () => {
  test('drop a chord MIDI → key/chords/rhythm → curated recipe → beat-fitted ideas', async ({ page }) => {
    await fresh(page);
    await importWav(page, 'sung-phrase');
    await dropFile(page, 'my beat chords.mid', demoBeatFile('cm-arp'));
    await expect(page.getByTestId('beat-key')).toContainText('C minor');
    await expect(page.getByTestId('beat-chords')).toContainText('Cm');
    await expect(page.getByTestId('beat-chords')).toContainText('Ab');
    await expect(page.getByTestId('beat-description')).toContainText('arpeggio');
    // session aligned to the beat
    expect(await state<number>(page, '(s) => s.doc.sequence.bpm')).toBe(150);
    expect(await state<any>(page, '(s) => [s.doc.sequence.settings.keyRoot, s.doc.sequence.settings.scale]')).toEqual([0, 'minor']);
    await expect(page.getByTestId('vocal-fit')).toBeVisible();
    // the arp gets the "ride the arp" recipe, which uses the beat itself as MIDI guide
    await expect(page.getByTestId('recipe-follow')).toContainText('Ride the arp');
    await page.getByTestId('recipe-go-hook').click();
    await expect(page.getByTestId('candidate')).toHaveCount(6);
    const desc = await state<string[][]>(page, '(s) => s.doc.candidates.map(c => c.description)');
    for (const d of desc) expect(d.some((x) => x.includes('Fitted to beat') && x.includes('C minor'))).toBe(true);
    await expect(page.getByTestId('beat-indicator')).toContainText('C minor');
    // ride the arp → MIDI-guided from the beat notes
    await page.getByTestId('nav-beat').click();
    await page.getByTestId('recipe-go-follow').click();
    expect(await state<string>(page, '(s) => s.doc.sequence.settings.mode')).toBe('midi');
    expect(await state<number>(page, '(s) => s.doc.sequence.settings.midi.notes.length')).toBeGreaterThan(30);
  });

  test('key override, fit settings, beat preview playback and persistence', async ({ page }) => {
    await fresh(page);
    await importWav(page, 'chop-attacks');
    await page.getByTestId('nav-beat').click();
    await page.getByTestId('demo-beat-dorian-stabs').click();
    await expect(page.getByTestId('beat-key')).toContainText('D dorian');
    await page.getByTestId('key-scale').selectOption('minor');
    await expect(page.getByTestId('beat-key')).toContainText('D minor');
    expect(await state<string>(page, '(s) => s.doc.sequence.settings.scale')).toBe('minor');
    await page.getByTestId('fit-rhythm').selectOption('follow');
    expect(await state<string>(page, '(s) => s.doc.beat.fit.rhythm')).toBe('follow');
    // preview synth is scheduled with the vocals
    await page.evaluate(() => ((window as any).__vcsEngine.debugSynth = []));
    await page.getByTestId('beat-play').click();
    await page.waitForTimeout(800);
    await page.getByTestId('beat-play').click();
    const synth = await page.evaluate(() => (window as any).__vcsEngine.debugSynth);
    expect(synth.length).toBeGreaterThan(3);
    expect(synth.every((n: any) => n.pitch >= 55 && n.pitch <= 72)).toBe(true);
    // turning the preview off stops it
    await page.getByTestId('beat-preview').uncheck();
    await page.evaluate(() => ((window as any).__vcsEngine.debugSynth = []));
    await page.getByTestId('beat-play').click();
    await page.waitForTimeout(500);
    await page.getByTestId('beat-play').click();
    expect(await page.evaluate(() => (window as any).__vcsEngine.debugSynth.length)).toBe(0);
    // one click returns to the detected key
    await page.getByTestId('key-auto').click();
    await expect(page.getByTestId('beat-key')).toContainText('D dorian');
    // save → reopen keeps the beat
    await page.getByTestId('project-name').fill('Beat test');
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('toasts')).toContainText('Saved');
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('project-menu').click();
    await page.getByTestId('menu-new').click();
    await page.getByTestId('project-menu').click();
    await page.getByTestId('menu-open').click();
    await page.getByTestId('open-Beat test').click();
    await expect(page.getByTestId('toasts')).toContainText('Opened');
    expect(await state<any>(page, '(s) => [s.doc.beat.name, s.doc.beat.fit.rhythm, s.doc.beat.fit.preview, s.doc.beat.chords.length]')).toEqual(['Dm7 – G7 off-beat stabs (128 BPM)', 'follow', false, 2]);
  });

  test('dropping vocal audio still imports a source', async ({ page }) => {
    await fresh(page);
    const { demoWav } = await import('./helpers');
    const w = demoWav('voice-b');
    await dropFile(page, w.name, new Uint8Array(w.buffer), 'audio/wav');
    await expect(page.getByTestId('source-list').locator('.source-item')).toHaveCount(1);
  });

  test('example G loads with a beat context', async ({ page }) => {
    await fresh(page);
    await page.getByTestId('welcome-example-fit-to-beat').click();
    await expect(page.getByTestId('beat-indicator')).toContainText('A minor');
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBeGreaterThan(5);
  });
});
