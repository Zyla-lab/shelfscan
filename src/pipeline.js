// Background recognition queue: capture is instant, recognition happens here one item at a
// time so the camera never waits for OCR / network.
import { getItem, getImages, putItem } from './db.js';
import { recognize } from './ocr.js';
import { parseLabel, parseGS1, tempFromText, findCasNumbers } from './parse.js';
import { readLabel, describeCompound, describeError, isConnectionError } from './claude.js';
import { resolve } from './pubchem.js';
import { settings } from './settings.js';

// Jobs: 'read' = read the label + PubChem (+ notes); 'describe' = only write the compound notes.
const queue = [];
const active = new Set();
const listeners = new Set();

export const onItemUpdated = (fn) => listeners.add(fn);
const notify = (item) => listeners.forEach((fn) => fn(item));
export const pendingCount = () => queue.length + active.size;

export function enqueue(id, job = 'read') {
  if (!queue.some((q) => q.id === id) && !active.has(id)) queue.push({ id, job });
  pump();
}

const claudeReady = () => {
  const s = settings.get();
  return s.engine === 'claude' && !!s.apiKey && navigator.onLine;
};

/** Item fields filled by describeCompound(). */
export const ABOUT_FIELDS = ['category', 'description', 'uses', 'areas', 'workingConc', 'stockSolution', 'handling', 'aboutBy'];

async function addNotes(item) {
  if (!item.name || !claudeReady()) return;
  try {
    const { data: d, usage } = await describeCompound(item, settings.get().apiKey);
    recordUsage(usage);
    if (!d.known) {
      item.aboutBy = 'unknown to Claude';
      return;
    }
    item.category = d.category;
    item.description = d.description;
    item.uses = d.uses;
    item.areas = (d.areas || []).join(', ');
    item.workingConc = d.working_concentration;
    item.stockSolution = d.stock_solution;
    item.handling = d.handling;
    item.aboutBy = 'Claude Haiku';
  } catch (e) {
    if (e.usage) recordUsage(e.usage);
    console.warn('notes failed', e); // non-fatal: "Add descriptions" in Settings retries
  }
}

async function describeItem(id) {
  const item = await getItem(id);
  if (!item?.name) return;
  await addNotes(item);
  item.updatedAt = new Date().toISOString();
  await putItem(item);
  notify(item);
}

// Claude requests are network-bound, so a few run side by side (a full re-read of a big library
// would otherwise take ages). On-device OCR is CPU-bound and runs one at a time.
const parallelism = () => (settings.get().engine === 'claude' && settings.get().apiKey ? 3 : 1);

function pump() {
  while (queue.length && active.size < parallelism()) {
    const { id, job } = queue.shift();
    active.add(id);
    (job === 'describe' ? describeItem(id).catch((e) => console.error(e)) : work(id)).finally(() => {
      active.delete(id);
      if (!queue.length && !active.size) notify(null);
      pump();
    });
  }
}

async function work(id) {
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

function recordUsage(u) {
  const prev = settings.get().usage || { calls: 0, inTok: 0, outTok: 0 };
  settings.set({ usage: { calls: prev.calls + 1, inTok: prev.inTok + u.inTok, outTok: prev.outTok + u.outTok } });
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
  let candidates = [];
  let casList = [];
  let read = null;

  if (s.engine === 'claude' && s.apiKey && navigator.onLine) {
    try {
      read = await readLabel(canvas, s.apiKey);
      recordUsage(read.usage);
    } catch (e) {
      if (e.usage) recordUsage(e.usage);
      // Offline / unreachable: still get something from the on-device reader.
      // Anything else (bad key, spend limit) is shown on the item so it can be retried.
      if (!isConnectionError(e)) throw new Error(describeError(e));
      item.error = `${describeError(e)} Read on the phone instead.`;
    }
  }

  if (read) {
    const d = read.data;
    item.engine = 'Claude Haiku';
    item.confidence = d.confidence;
    item.aiTokens = read.usage.inTok + read.usage.outTok;
    // a misread CAS fails the checksum and is dropped rather than sent to PubChem
    casList = findCasNumbers(d.cas || '');
    if (d.cas && !casList.length) item.error = `CAS on label read as "${d.cas}", which is not a valid CAS number.`;
    candidates = [...new Set([d.search_name, d.name].map((x) => (x || '').trim()).filter(Boolean))];
    fill(item, 'supplier', d.supplier);
    fill(item, 'catalog', d.catalog);
    fill(item, 'lot', d.lot);
    fill(item, 'amount', d.amount);
    fill(item, 'purity', [d.concentration, d.purity].filter(Boolean).join(', '));
    fill(item, 'expiry', d.expiry);
    fill(item, 'storage', d.storage);
    fill(item, 'signal', d.signal_word);
    fill(item, 'hazards', d.hazard_codes);
    item.ocrText = Object.entries(d)
      .filter(([k, v]) => v && typeof v === 'string' && !['confidence', 'search_name'].includes(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    if (!d.legible) item.error = 'Claude could not read a label in this photo. Retake it with the label facing the camera.';
  } else {
    item.engine = 'on-device';
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

  // A CAS number typed by the user beats whatever was read, and drives the PubChem lookup
  if (item.casEdited && item.cas) casList = [item.cas, ...casList.filter((c) => c !== item.cas)];
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
    item.name = pc?.title || read?.data.name || candidates[0] || '';
  }
  if (read) {
    // A lab-made solution has no CAS and may not be in PubChem; a confident read is enough.
    const d = read.data;
    item.status = d.legible && item.name && d.confidence !== 'low' && !item.error ? 'done' : 'review';
  } else {
    item.status = item.name && (item.cas || pc) ? 'done' : 'review';
  }
  item.updatedAt = new Date().toISOString();
  await putItem(item);
  notify(item);
  // Notes only for confidently identified items (a wrong identity would give wrong notes).
  // Re-fetched inside describeItem so edits made meanwhile are not overwritten.
  if (item.status === 'done' && !item.description) await describeItem(id);
}
