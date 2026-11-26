// Compares a screenshot with its approved image in tests/browser/approved/ (approved.spec.mjs). The pixels are compared
// in the browser, so no image library is needed. A pixel differs when any color channel moves by more than
// CHANNEL_STEP, which ignores the faint edge shading that varies between runs.
import fs from 'node:fs';
import path from 'node:path';

export const APPROVED_DIR = 'tests/browser/approved';
// Where a screen that does not match leaves its new image and a map of what changed, for CI to upload.
export const CHANGED_DIR = 'out/browser/approved';
const CHANNEL_STEP = 32;

/** The approved image's path for a screen, or null when none is committed yet. */
export function approvedPath(name) {
  const file = path.join(APPROVED_DIR, `${name}.png`);
  return fs.existsSync(file) ? file : null;
}

/** Saves `png` as the screen's approved image (PUNCHLIST_APPROVE=1). */
export function approve(name, png) {
  fs.mkdirSync(APPROVED_DIR, { recursive: true });
  fs.writeFileSync(path.join(APPROVED_DIR, `${name}.png`), png);
}

/** Leaves the new image and the map of changed pixels where CI uploads them. */
export function keepChanged(name, png, diffPng) {
  fs.mkdirSync(CHANGED_DIR, { recursive: true });
  fs.writeFileSync(path.join(CHANGED_DIR, `${name}.png`), png);
  if (diffPng) fs.writeFileSync(path.join(CHANGED_DIR, `${name}.diff.png`), diffPng);
}

/**
 * How many pixels of `actual` differ from `expected` (both PNG buffers), with a picture of them in red. Runs in
 * `page`, which may be any page of the browser.
 */
export async function differingPixels(page, expected, actual) {
  const images = [expected.toString('base64'), actual.toString('base64')];
  const result = await page.evaluate(comparePngs, [...images, CHANNEL_STEP]);
  return { ...result, diffPng: result.diff ? Buffer.from(result.diff, 'base64') : null };
}

// Runs in the browser: decodes both images, counts the pixels that differ, and paints them red on a dimmed copy.
async function comparePngs([expectedBase64, actualBase64, step]) {
  const decode = async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return { canvas, data: context.getImageData(0, 0, bitmap.width, bitmap.height) };
  };
  const expected = await decode(expectedBase64);
  const actual = await decode(actualBase64);
  if (expected.data.width !== actual.data.width || expected.data.height !== actual.data.height) {
    return { differing: -1, total: actual.data.width * actual.data.height, diff: null };
  }
  const a = expected.data.data;
  const b = actual.data.data;
  const marks = new ImageData(actual.data.width, actual.data.height);
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    const moved = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    const changed = moved > step;
    if (changed) differing += 1;
    marks.data.set(changed ? [255, 0, 0, 255] : [b[i] / 3, b[i + 1] / 3, b[i + 2] / 3, 255], i);
  }
  const canvas = new OffscreenCanvas(marks.width, marks.height);
  canvas.getContext('2d').putImageData(marks, 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { differing, total: a.length / 4, diff: btoa(binary) };
}
