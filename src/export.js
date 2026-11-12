// CSV / ZIP export and ZIP backup import.
import JSZip from 'jszip';
import { allItems, getImages, putItem, putImages } from './db.js';

export const COLUMNS = [
  ['name', 'Name'],
  ['cas', 'CAS'],
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
    onProgress?.(i + 1, items.length);
  }
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

const htmlEsc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function blobToDataURL(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve('');
    r.readAsDataURL(blob);
  });
}

/** Self-contained, printable HTML datasheet with a thumbnail of every container. */
export async function exportHTML() {
  const items = sorted(await allItems());
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const imgs = await getImages(it.id);
    const src = imgs?.thumb ? await blobToDataURL(imgs.thumb) : '';
    const sig = /danger/i.test(it.signal) ? 'danger' : /warn/i.test(it.signal) ? 'warn' : '';
    rows.push(`<tr>
      <td class="n">${i + 1}</td>
      <td>${src ? `<img src="${src}" alt="">` : ''}</td>
      <td><b>${htmlEsc(it.name || 'Unnamed')}</b><div class="s">${htmlEsc([it.formula, it.mw && `${it.mw} g/mol`].filter(Boolean).join(' · '))}</div>
        ${it.signal ? `<div class="sig ${sig}">${htmlEsc(it.signal)}${it.hazards ? ` · ${htmlEsc(it.hazards)}` : ''}</div>` : ''}</td>
      <td class="m">${htmlEsc(it.cas)}</td>
      <td>${htmlEsc(it.supplier)}<div class="s m">${htmlEsc(it.catalog)}</div><div class="s m">${it.lot ? `Lot ${htmlEsc(it.lot)}` : ''}</div></td>
      <td>${htmlEsc(it.amount)}<div class="s">${htmlEsc(it.purity)}</div></td>
      <td>${htmlEsc(it.location)}<div class="s">${htmlEsc(it.temp)}</div></td>
    </tr>`);
  }
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chemical inventory ${new Date().toLocaleDateString()}</title>
<style>
body{font:13px/1.35 system-ui,sans-serif;margin:24px;color:#0f1726}
h1{font-size:20px;margin:0}.meta{color:#5b6678;margin:4px 0 16px}
table{border-collapse:collapse;width:100%}th{background:#0f1726;color:#fff;text-align:left;font-size:11px;text-transform:uppercase;padding:8px}
td{border-bottom:1px solid #dde2ea;padding:6px 8px;vertical-align:top}tr{page-break-inside:avoid}
img{width:64px;height:76px;object-fit:cover;border-radius:6px}.s{color:#5b6678;font-size:12px}.m{font-family:ui-monospace,Menlo,monospace}
.n{color:#5b6678}.sig{font-size:11px;font-weight:700;margin-top:3px}.danger{color:#c62f2f}.warn{color:#b26a00}
@media print{body{margin:8mm}}
</style></head><body>
<h1>Chemical inventory</h1><div class="meta">${items.length} containers · generated ${htmlEsc(new Date().toLocaleString())}</div>
<table><thead><tr><th>#</th><th>Photo</th><th>Chemical</th><th>CAS</th><th>Supplier / Cat / Lot</th><th>Amount</th><th>Location / Temp</th></tr></thead>
<tbody>${rows.join('')}</tbody></table></body></html>`;
  await saveFile(new Blob([doc], { type: 'text/html' }), `chemicals_${stamp()}.html`);
}
