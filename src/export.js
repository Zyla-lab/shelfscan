// CSV / ZIP export and ZIP backup import.
import JSZip from 'jszip';
import { allItems, getImages, putItem, putImages } from './db.js';

export const COLUMNS = [
  ['name', 'Name'],
  ['cas', 'CAS'],
  ['category', 'Category'],
  ['description', 'Description'],
  ['uses', 'Used for'],
  ['areas', 'Research areas'],
  ['workingConc', 'Working concentration'],
  ['stockSolution', 'Stock solution'],
  ['handling', 'Handling'],
  ['formula', 'Formula'],
  ['mw', 'MW (g/mol)'],
  ['supplier', 'Supplier'],
  ['catalog', 'Catalog #'],
  ['lot', 'Lot'],
  ['amount', 'Amount'],
  ['purity', 'Purity / grade'],
  ['expiry', 'Expiry'],
  ['location', 'Location'],
  ['temp', 'Storage temp'],
  ['signal', 'GHS signal'],
  ['hazards', 'H-codes'],
  ['pictograms', 'GHS pictograms'],
  ['storage', 'Storage'],
  ['notes', 'Notes'],
  ['iupac', 'IUPAC name'],
  ['smiles', 'SMILES'],
  ['inchikey', 'InChIKey'],
  ['cid', 'PubChem CID'],
  ['barcode', 'Barcode'],
  ['createdAt', 'Scanned at'],
  ['ocrText', 'Label text'],
  ['id', 'ID'],
];

function csvCell(v) {
  if (v == null) return '';
  if (Array.isArray(v)) v = v.join('; ');
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function slug(s) {
  return (s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unknown';
}

export function imageFileName(item, index) {
  return `${String(index + 1).padStart(4, '0')}_${slug(item.name || item.cas)}.jpg`;
}

function sorted(items) {
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function toCSV(items, withImageCol = false) {
  const cols = withImageCol ? [...COLUMNS, ['__image', 'Image file']] : COLUMNS;
  const rows = [cols.map(([, h]) => csvCell(h)).join(',')];
  sorted(items).forEach((it, i) => {
    rows.push(cols.map(([k]) => csvCell(k === '__image' ? `images/${imageFileName(it, i)}` : it[k])).join(','));
  });
  // BOM so Excel opens UTF-8 (µ, ≥, °) correctly
  return '﻿' + rows.join('\r\n');
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

/** Save via the share sheet on phones (Files / Drive / email), else a normal download. */
export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] }) && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportCSV() {
  const items = await allItems();
  await saveFile(new Blob([toCSV(items)], { type: 'text/csv' }), `chemicals_${stamp()}.csv`);
}

export async function exportZIP(onProgress) {
  const items = sorted(await allItems());
  const zip = new JSZip();
  zip.file('catalog.csv', toCSV(items, true));
  zip.file('catalog.json', JSON.stringify({ app: 'chemscan', version: 1, exportedAt: new Date().toISOString(), items }, null, 2));
  const folder = zip.folder('images');
  for (let i = 0; i < items.length; i++) {
    const imgs = await getImages(items[i].id);
    if (imgs?.full) folder.file(imageFileName(items[i], i), imgs.full);
    onProgress?.(i + 1, items.length * 2);
  }
  zip.file('catalog.html', await catalogHTML(items, true, (i, n) => onProgress?.(n + i, n * 2)));
  zip.file('README.txt', README(items.length, new Date().toLocaleString()));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  await saveFile(new Blob([blob], { type: 'application/zip' }), `chemicals_${stamp()}.zip`);
}

/** Restore a ZIP produced by exportZIP. Existing items with the same ID are overwritten. */
export async function importZIP(file, makeThumb) {
  const zip = await JSZip.loadAsync(file);
  const json = zip.file('catalog.json');
  if (!json) throw new Error('Not a ShelfScan backup (catalog.json missing).');
  const { items } = JSON.parse(await json.async('string'));
  const ordered = sorted(items);
  let n = 0;
  for (let i = 0; i < ordered.length; i++) {
    const it = ordered[i];
    const imgEntry = zip.file(`images/${imageFileName(it, i)}`);
    if (imgEntry) {
      const full = new Blob([await imgEntry.async('arraybuffer')], { type: 'image/jpeg' });
      await putImages(it.id, full, await makeThumb(full));
    }
    if (it.status === 'processing') it.status = 'review';
    await putItem(it);
    n++;
  }
  return n;
}

function blobToDataURL(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve('');
    r.readAsDataURL(blob);
  });
}

/** Re-encode a photo at a smaller size for embedding in the HTML catalog. */
async function shrink(blob, maxSide, quality) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return blobToDataURL(out);
}

// What the catalog shows: the export columns plus status; internal bookkeeping is left out.
const CATALOG_KEYS = [...COLUMNS.map(([k]) => k), 'status'];
const pick = (it) => Object.fromEntries(CATALOG_KEYS.filter((k) => it[k] != null && it[k] !== '').map((k) => [k, it[k]]));

/**
 * Build the offline catalog HTML. Photos are embedded (240 px for lists, 900 px for the detail
 * view: about 100 KB per container, so ~15 MB for 150), so the file works on its own.
 * @param {object[]} items sorted items
 * @param {boolean} withFullLinks link each item to images/<file> (true inside the ZIP)
 */
async function catalogHTML(items, withFullLinks, onProgress) {
  const thumbs = {};
  const photos = {};
  const full = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const imgs = await getImages(it.id);
    if (imgs?.thumb) thumbs[it.id] = await shrink(imgs.thumb, 240, 0.7);
    if (imgs?.full) {
      photos[it.id] = await shrink(imgs.full, 900, 0.72);
      if (withFullLinks) full[it.id] = `images/${imageFileName(it, i)}`;
    }
    onProgress?.(i + 1, items.length);
  }
  const { viewerHTML } = await import('./viewer.js');
  return viewerHTML({
    title: 'Chemical inventory',
    exportedAt: new Date().toISOString(),
    items: items.map(pick),
    thumbs,
    photos,
    full,
  });
}

/** Single-file offline catalog (search, filters, details, print), for sharing or archiving. */
export async function exportCatalog(onProgress) {
  const items = sorted(await allItems());
  const html = await catalogHTML(items, false, onProgress);
  await saveFile(new Blob([html], { type: 'text/html' }), `chemical-inventory_${stamp()}.html`);
}

export const README = (n, when) => `Chemical inventory: ${n} containers, exported ${when} from ShelfScan.

catalog.html   Open in any web browser (phone or computer, works offline). Search, filter by
               category / location / temperature, cards or table, details with photos, Print.
catalog.csv    The same data as a spreadsheet (UTF-8; opens in Excel, Numbers, LibreOffice).
               The "Image file" column names each container's photo in images/.
catalog.json   Complete machine-readable data.
images/        Full-resolution photo of every container.

To continue editing on a phone: open ShelfScan (https://zyla-lab.github.io/shelfscan/),
Settings > Import backup ZIP, and pick this ZIP file.

Descriptions, uses and concentrations were written by Claude from general knowledge; check them
before relying on them. Formula, MW, IUPAC, SMILES and GHS data come from PubChem.
`;
