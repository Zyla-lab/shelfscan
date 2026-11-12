// Background recognition queue: capture is instant, recognition happens here one item at a
// time so the camera never waits for OCR / network.
import { getItem, getImages, putItem } from './db.js';
import { recognize } from './ocr.js';
import { parseLabel, parseGS1, tempFromText } from './parse.js';
import { resolve } from './pubchem.js';
import { settings } from './settings.js';

const queue = [];
let running = false;
const listeners = new Set();

export const onItemUpdated = (fn) => listeners.add(fn);
const notify = (item) => listeners.forEach((fn) => fn(item));
export const pendingCount = () => queue.length + (running ? 1 : 0);

export function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await processItem(id);
    } catch (e) {
      console.error(e);
      const item = await getItem(id);
      if (item) {
        item.status = 'error';
        item.error = String(e.message || e);
        await putItem(item);
        notify(item);
      }
    }
  }
  running = false;
  notify(null);
}

async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

async function readBarcodes(canvas) {
  if (!('BarcodeDetector' in window)) return [];
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const det = new window.BarcodeDetector({ formats: supported });
    const codes = await det.detect(canvas);
    return codes.map((c) => c.rawValue).filter(Boolean);
  } catch {
    return [];
  }
}

const fill = (item, key, value) => {
  if (value && !item[key]) item[key] = value;
};

async function processItem(id) {
  const item = await getItem(id);
  if (!item) return;
  const imgs = await getImages(id);
  if (!imgs?.full) throw new Error('Image missing');
  item.status = 'processing';
  item.error = '';
  notify(item);

  const canvas = await blobToCanvas(imgs.full);
  const s = settings.get();
  item.engine = 'on-device';
  let candidates = [];
  let casList = [];

  {
    const { text, lines } = await recognize(canvas);
    const p = parseLabel(text, lines);
    item.ocrText = text.trim();
    casList = p.casAll;
    candidates = p.nameCandidates;
    fill(item, 'supplier', p.supplier);
    fill(item, 'catalog', p.catalog);
    fill(item, 'lot', p.lot);
    fill(item, 'amount', p.amount);
    fill(item, 'purity', p.purity);
    fill(item, 'formula', p.formula);
    fill(item, 'mw', p.mw);
    fill(item, 'expiry', p.expiry);
    fill(item, 'signal', p.signal);
  }
  item.candidates = candidates;

  const codes = await readBarcodes(canvas);
  if (codes.length) {
    item.barcode = codes.join(' | ');
    for (const c of codes) {
      const g = parseGS1(c);
      fill(item, 'lot', g.lot);
      fill(item, 'expiry', g.expiry);
      fill(item, 'catalog', g.catalog);
    }
  }

  if (casList[0]) fill(item, 'cas', casList[0]);
  // batch default wins (it's where the bottle actually lives); otherwise use the label
  fill(item, 'temp', tempFromText(`${item.storage || ''}\n${item.ocrText || ''}`));

  let pc = null;
  if (s.pubchem && navigator.onLine) {
    pc = await resolve({ casList, names: candidates });
  }
  if (pc) {
    item.cid = pc.cid;
    item.iupac = pc.iupac;
    item.smiles = pc.smiles;
    item.inchikey = pc.inchikey;
    item.pubchemName = pc.title;
    item.matchedBy = pc.matchedBy;
    // PubChem values are canonical; prefer them over OCR'd ones
    item.formula = pc.formula || item.formula;
    item.mw = pc.mw || item.mw;
    fill(item, 'cas', pc.cas);
    if (pc.ghs) {
      fill(item, 'signal', pc.ghs.signal);
      if (!item.hazards && pc.ghs.hazards.length) item.hazards = pc.ghs.hazards.join(', ');
      item.pictograms = pc.ghs.pictograms.join(', ');
    }
  }

  if (!item.nameEdited) {
    // PubChem's title is cleaner than raw OCR text; fall back to the best OCR line
    item.name = pc?.title || candidates[0] || '';
  }
  item.status = item.name && (item.cas || pc) ? 'done' : 'review';
  item.updatedAt = new Date().toISOString();
  await putItem(item);
  notify(item);
}
