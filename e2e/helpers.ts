import { expect, type Page, type Download } from '@playwright/test';
import { readFileSync } from 'fs';
import { demoVoice } from '../src/core/demo/synthVoice';
import { encodeWav, decodeWav } from '../src/core/audio/wav';

export function demoWav(name: string) {
  return { name: `${name}.wav`, mimeType: 'audio/wav', buffer: Buffer.from(encodeWav(demoVoice(name), 16)) };
}

/** Read app state through the test hook installed by App.tsx. */
export async function state<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate((src) => {
    const s = (window as any).__vcs.useStore.getState();
    return new Function('s', `return (${src})(s)`)(s);
  }, fn);
}

export async function importWav(page: Page, name: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-audio').first().click();
  await (await chooser).setFiles(demoWav(name));
}

export async function downloadBytes(d: Download): Promise<Buffer> {
  const p = await d.path();
  return readFileSync(p!);
}

export function wavInfo(buf: Buffer) {
  const a = decodeWav(new Uint8Array(buf));
  let peak = 0;
  for (const ch of a.channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  return { sampleRate: a.sampleRate, channels: a.channels.length, frames: a.channels[0].length, seconds: a.channels[0].length / a.sampleRate, peak };
}

/** Drag across the ruler to select bars [from, to). */
export async function dragRulerBars(page: Page, from: number, to: number) {
  const bars = await state<number>(page, '(s) => s.doc.sequence.bars');
  const box = (await page.getByTestId('ruler').boundingBox())!;
  const bw = box.width / bars;
  await page.mouse.move(box.x + bw * (from + 0.5), box.y + 22);
  await page.mouse.down();
  await page.mouse.move(box.x + bw * (to - 0.5), box.y + 22, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('bar-selection')).toBeVisible();
}

export async function fresh(page: Page) {
  await page.goto('/');
  await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase('vocal-chop-studio'); q.onsuccess = q.onerror = q.onblocked = () => r(null); }));
  await page.goto('/');
  await expect(page.getByText('Turn one vocal into many musical ideas.')).toBeVisible();
}
