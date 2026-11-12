// On-device OCR with Tesseract.js (runs in a Web Worker; nothing leaves the phone except
// the one-time download of the OCR engine and English language data).
import { createWorker } from 'tesseract.js';

let workerP = null;

function getWorker() {
  if (!workerP) {
    workerP = createWorker('eng', 1).catch((e) => {
      workerP = null;
      throw e;
    });
  }
  return workerP;
}

/** Warm up in the background so the first scan isn't slow. */
export function preloadOCR() {
  getWorker().catch(() => {});
}

/** Grayscale + contrast stretch, scaled so the long side is ~2000px. */
function preprocess(src) {
  const long = Math.max(src.width, src.height);
  const scale = Math.min(2, 2000 / long);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    d[i] = y;
    hist[y]++;
  }
  // 1% / 99% percentiles for the stretch
  const total = d.length / 4;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < total * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < total * 0.01; hi--);
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function collectLines(data) {
  const lines = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const text = (l.text || '').trim();
        if (!text) continue;
        lines.push({ text, height: l.bbox ? l.bbox.y1 - l.bbox.y0 : 10, conf: l.confidence ?? 60 });
      }
    }
  }
  return lines;
}

/**
 * @param {HTMLCanvasElement} canvas full-resolution frame
 * @returns {Promise<{text:string, lines:{text:string,height:number,conf:number}[]}>}
 */
export async function recognize(canvas) {
  const worker = await getWorker();
  const img = preprocess(canvas);
  await worker.setParameters({ tessedit_pageseg_mode: '3' });
  let { data } = await worker.recognize(img, { rotateAuto: true }, { text: true, blocks: true });
  let lines = collectLines(data);
  let text = data.text || '';
  // Labels are often sparse; if auto layout found little, try sparse-text mode.
  if ((text.match(/[A-Za-z]/g) || []).length < 25) {
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const second = await worker.recognize(img, { rotateAuto: true }, { text: true, blocks: true });
    if ((second.data.text || '').length > text.length) {
      data = second.data;
      text = data.text || '';
      lines = collectLines(data);
    }
  }
  return { text, lines };
}
