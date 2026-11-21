import { test, expect, type Page } from '@playwright/test';
import { freshStudio, studioIdle, state, demoWav, downloadBytes, wavInfo } from './helpers';
import { demoBeatMidi } from '../src/core/demo/beats';

async function drop(page: Page, files: { name: string; bytes: Uint8Array; mime: string }[]) {
  await page.evaluate(
    (fs: { name: string; data: number[]; mime: string }[]) => {
      const dt = new DataTransfer();
      for (const f of fs) dt.items.add(new File([new Uint8Array(f.data)], f.name, { type: f.mime }));
      for (const t of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    files.map((f) => ({ name: f.name, data: Array.from(f.bytes), mime: f.mime })),
  );
}
const selected = (page: Page) => state<any>(page, '(s) => s.doc.candidates.find(c => c.id === s.ui.idea)');

test.describe('Studio', () => {
  test('drop a vocal → chopped, key found, ideas across styles → play → dive into a style', async ({ page }) => {
    await freshStudio(page);
    const wav = demoWav('sung-phrase');
    await drop(page, [{ name: 'my vocal.wav', bytes: new Uint8Array(wav.buffer), mime: 'audio/wav' }]);
    await expect(page.getByTestId('studio')).toBeVisible();
    await studioIdle(page);
    await expect(page.getByTestId('idea')).toHaveCount(10);
    const styles = await state<string[]>(page, '(s) => s.doc.candidates.map(c => c.style)');
    expect(new Set(styles).size).toBe(10);
    expect(await state<boolean>(page, '(s) => s.doc.sequence.settings.keyAuto')).toBe(true);
    await expect(page.getByTestId('pad').first()).toBeVisible();
    // click a card → it plays, and the pads light up with its chops
    await page.getByTestId('idea').nth(1).click();
    await expect.poll(() => state<boolean>(page, '(s) => s.playing')).toBe(true);
    const id = await state<string>(page, '(s) => s.ui.idea');
    expect(await state<string>(page, '(s) => s.ui.auditioning')).toBe(id);
    await expect.poll(() => page.locator('.pad.lit').count(), { timeout: 8000 }).toBeGreaterThan(0);
    // clicking the playing card stops it
    await page.getByTestId('idea').nth(1).click();
    await expect.poll(() => state<boolean>(page, '(s) => s.playing')).toBe(false);
    // dive into Garage: six takes in that style
    await page.getByTestId('tab-garage').click();
    await studioIdle(page);
    expect(await page.getByTestId('idea').count()).toBeGreaterThanOrEqual(7);
    const inTab = await state<string[]>(page, '(s) => s.doc.candidates.filter(c => c.style === "garage").map(c => c.settings.direction)');
    expect(inTab.every((d) => d === 'ukg')).toBe(true);
    // a tweak writes a new batch in that style
    const n = await page.getByTestId('idea').count();
    await page.getByTestId('tweak-energy').getByText('Hype').click();
    await studioIdle(page);
    expect(await page.getByTestId('idea').count()).toBe(n + 6);
    expect(await state<number>(page, '(s) => s.doc.candidates.filter(c => c.style === "garage").at(-1).settings.complexity')).toBeGreaterThan(0.6);
  });

  test('shape an idea: swap a chop, shuffle, undo, layers, pitch, like, variations, keys', async ({ page }) => {
    await freshStudio(page);
    await page.getByTestId('welcome-demo').click();
    await studioIdle(page);
    const c0 = await selected(page);
    const chops0 = [...new Set(c0.events.map((e: any) => e.sliceId))];
    // swap one chop: rhythm stays
    await page.getByTestId('chop-chip').first().click();
    await expect(page.getByTestId('swap-picker')).toBeVisible();
    await page.getByTestId('swap-option').first().click();
    const c1 = await selected(page);
    expect(c1.events.map((e: any) => e.tick)).toEqual(c0.events.map((e: any) => e.tick));
    expect([...new Set(c1.events.map((e: any) => e.sliceId))]).not.toEqual(chops0);
    // shuffle, then undo twice → back to the original
    await page.getByTestId('shuffle').click();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect((await selected(page)).events).toEqual(c0.events);
    // pitch and layers
    await page.getByTestId('pitch-up-oct').click();
    expect((await selected(page)).events[0].semitones).toBe(c0.events[0].semitones + 12);
    await page.getByTestId('layer-toggle').first().click();
    expect((await selected(page)).tracks.some((t: any) => t.mute)).toBe(true);
    // like with F, show in the Liked tab
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('f');
    await page.getByTestId('tab-liked').click();
    await expect(page.getByTestId('idea')).toHaveCount(1);
    await page.getByTestId('tab-all').click();
    // variations land right after their idea
    const before = await page.getByTestId('idea').count();
    await page.getByTestId('idea-more').click();
    await studioIdle(page);
    await expect(page.getByTestId('idea')).toHaveCount(before + 4);
    const kids = await state<number>(page, `(s) => s.doc.candidates.filter(c => c.parentId === "${c0.id}").length`);
    expect(kids).toBe(4);
    // arrow keys move through ideas; number keys play pads
    const a = await state<string>(page, '(s) => s.ui.idea');
    await page.keyboard.press('ArrowRight');
    expect(await state<string>(page, '(s) => s.ui.idea')).not.toBe(a);
    await page.keyboard.press('1');
    expect(await page.evaluate(() => !!(window as any).__vcsEngine.auditionInfo)).toBe(true);
    // Space toggles the selected idea (swapping a chop above already started playback)
    const was = await state<boolean>(page, '(s) => s.playing');
    await page.keyboard.press('Space');
    await expect.poll(() => state<boolean>(page, '(s) => s.playing')).toBe(!was);
    await page.keyboard.press('Space');
    await expect.poll(() => state<boolean>(page, '(s) => s.playing')).toBe(was);
  });

  test('get it out: drag prepares a WAV, Save WAV and MIDI + chops download', async ({ page }) => {
    await freshStudio(page);
    await page.getByTestId('welcome-demo').click();
    await studioIdle(page);
    // drag: rendered on hover, handed over as a file on dragstart
    await page.getByTestId('idea').first().hover();
    await page.waitForTimeout(600);
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await page.getByTestId('idea').first().dispatchEvent('dragstart', { dataTransfer: dt });
    expect(await dt.evaluate((d) => d.getData('DownloadURL'))).toMatch(/^audio\/wav:.*_140bpm\.wav:blob:/);
    await page.getByTestId('pad').first().hover();
    await page.waitForTimeout(300);
    const dt2 = await page.evaluateHandle(() => new DataTransfer());
    await page.getByTestId('pad').first().dispatchEvent('dragstart', { dataTransfer: dt2 });
    expect(await dt2.evaluate((d) => d.getData('DownloadURL'))).toMatch(/_chop_.*\.wav:blob:/);
    // save the selected idea
    let dl = page.waitForEvent('download');
    await page.getByTestId('idea-save').click();
    const info = wavInfo(await downloadBytes(await dl));
    expect(info.seconds).toBeGreaterThan(8 * 4 * 60 / 140 - 0.05);
    expect(info.peak).toBeGreaterThan(0.01);
    dl = page.waitForEvent('download');
    await page.getByText('MIDI + chops').click();
    expect((await dl).suggestedFilename()).toMatch(/\.zip$/);
    // open in the timeline editor
    await page.getByTestId('idea-editor').click();
    await expect(page.getByTestId('sequencer')).toBeVisible();
    expect(await state<number>(page, '(s) => s.doc.sequence.events.length')).toBeGreaterThan(0);
  });

  test('a beat dropped in the Studio refits the ideas to it', async ({ page }) => {
    await freshStudio(page);
    await page.getByTestId('welcome-demo').click();
    await studioIdle(page);
    await drop(page, [{ name: 'beat.mid', bytes: demoBeatMidi('full-beat'), mime: 'audio/midi' }]);
    await studioIdle(page);
    await expect(page.getByTestId('studio-beat')).toContainText('Am');
    expect(await state<string>(page, '(s) => s.ui.view')).toBe('studio');
    const fitted = await state<number>(page, '(s) => s.doc.candidates.filter(c => c.description.some(d => d.includes("Fitted to beat"))).length');
    expect(fitted).toBeGreaterThanOrEqual(8);
  });
});
