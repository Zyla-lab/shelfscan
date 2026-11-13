import { Camera, AutoCapture } from './camera.js';
import { putItem, putImages, getItem, getImages, allItems, deleteItem, clearAll, requestPersistence } from './db.js';
import { enqueue, onItemUpdated, pendingCount, ABOUT_FIELDS } from './pipeline.js';
import { preloadOCR } from './ocr.js';
import { testKey, costOf, describeError } from './claude.js';
import { exportCSV, exportZIP, exportCatalog, importZIP } from './export.js';
import { TEMPS } from './parse.js';
import { structureImageUrl, compoundPageUrl } from './pubchem.js';
import { settings } from './settings.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const video = $('#video');
const camera = new Camera(video);
let items = []; // in-memory mirror of the DB, newest first
const thumbUrls = new Map();
let currentView = 'scan';
let openId = null;
let wakeLock = null;

// ---------------------------------------------------------------- utilities
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

let audioCtx;
function tone(freqs, gap = 0.07, vol = 0.1) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    freqs.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(vol, t0 + i * gap);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * gap + 0.2);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * gap);
      o.stop(t0 + i * gap + 0.21);
    });
  } catch {
    /* audio unavailable */
  }
}
function chime() {
  if (settings.get().beep) tone([880, 1175, 1760], 0.065, 0.08);
}
function feedback() {
  if (!settings.get().beep) return;
  navigator.vibrate?.(70);
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 1320;
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.16);
  } catch {
    /* audio unavailable */
  }
}

function canvasToBlob(canvas, maxSide, quality = 0.85) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  let c = canvas;
  if (scale < 1) {
    c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  }
  return new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
}

async function makeThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  const s = 360 / Math.max(bmp.width, bmp.height);
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return canvasToBlob(c, 360, 0.75);
}

async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const imgs = await getImages(id);
  const url = imgs?.thumb ? URL.createObjectURL(imgs.thumb) : '';
  thumbUrls.set(id, url);
  return url;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------------------------------------------------------------- capture
const STATUS_TEXT = {
  calibrating: 'Point at an empty spot…',
  ready: 'Ready — place a chemical',
  moving: 'Hold still…',
  holding: 'Hold still…',
  capturing: 'Capturing…',
  'captured-waiting': '✓ Scanned — swap for the next one',
};

let lastStatusOverride = 0;
function setStatus(text, cls = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${cls}`;
}

const auto = new AutoCapture(video, {
  onState(state, { progress }) {
    $('#hold-bar').style.width = `${Math.round(progress * 100)}%`;
    const frame = $('#frame');
    frame.className = `frame ${state === 'holding' ? 'holding' : state === 'captured-waiting' ? 'done' : state === 'ready' ? 'ready' : ''}`;
    if (performance.now() < lastStatusOverride) return;
    setStatus(STATUS_TEXT[state] || '', state === 'captured-waiting' ? 'ok' : '');
  },
  onTrigger: () => capture('auto'),
});
if (import.meta.env.DEV) window.__auto = auto; // for debugging / tests

let capturing = false;
async function capture(source) {
  if (capturing || !camera.running) return;
  capturing = true;
  try {
    const canvas = camera.grab();
    $('#flash').classList.remove('go');
    void $('#flash').offsetWidth;
    $('#flash').classList.add('go');
    feedback();
    if (source === 'manual') auto.markCaptured();
    await addScan(canvas);
  } catch (e) {
    console.error(e);
    setStatus('Capture failed', 'err');
  } finally {
    capturing = false;
  }
}

/** Store a captured frame (camera or uploaded photo) and queue it for recognition. */
async function addScan(canvas) {
  const full = await canvasToBlob(canvas, 1920, 0.85);
  const thumb = await makeThumb(full);
  const now = new Date().toISOString();
  const item = {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    status: 'processing',
    name: '',
    location: settings.get().location || '',
    temp: settings.get().temp || '',
    notes: '',
  };
  await putImages(item.id, full, thumb);
  await putItem(item);
  thumbUrls.set(item.id, URL.createObjectURL(thumb));
  items.unshift(item);
  renderRecent(item.id);
  renderCount();
  lastStatusOverride = performance.now() + 1400;
  setStatus(`✓ Captured #${items.length} — reading label…`, 'ok');
  enqueue(item.id);
  updateQueueChip();
}

async function addPhotos(files) {
  let n = 0;
  for (const f of files) {
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      await addScan(c);
      n++;
    } catch (e) {
      console.error(e);
    }
  }
  toast(n ? `Added ${n} photo${n === 1 ? '' : 's'}` : 'Could not read that image');
}
document.querySelectorAll('.photo-input').forEach((inp) =>
  inp.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) await addPhotos(files);
  }),
);

async function startCamera() {
  $('#cam-error').classList.add('hidden');
  setStatus('Starting camera…');
  if (!window.isSecureContext) {
    showCamError('The camera needs HTTPS. Open this app via an https:// address (see README).');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showCamError('This browser does not support camera access.');
    return;
  }
  try {
    await camera.start();
    auto.reset();
    auto.enabled = settings.get().autoCapture;
    auto.start();
    $('#btn-torch').disabled = !camera.torchSupported;
    $('#btn-torch').setAttribute('aria-pressed', 'false');
    setStatus(settings.get().autoCapture ? STATUS_TEXT.calibrating : 'Tap the shutter to capture');
    acquireWakeLock();
  } catch (e) {
    console.error(e);
    showCamError(
      e.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access for this site in your browser settings, then tap Start.'
        : `Could not start the camera (${e.name || e.message}).`,
    );
  }
}

function showCamError(msg) {
  $('#cam-error-msg').textContent = msg;
  $('#cam-error').classList.remove('hidden');
  setStatus('Camera off');
}

function stopCamera() {
  auto.stop();
  camera.stop();
  releaseWakeLock();
}

async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported / denied */
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------------------------------------------------------------- rendering
function statusTag(it) {
  if (it.status === 'processing') return '<span class="tag"><span class="spin"></span> reading</span>';
  if (it.status === 'review') return '<span class="tag warn">check</span>';
  if (it.status === 'error') return '<span class="tag danger">error</span>';
  return '';
}

function signalTag(it) {
  if (/danger/i.test(it.signal)) return '<span class="tag danger">Danger</span>';
  if (/warning/i.test(it.signal)) return '<span class="tag warn">Warning</span>';
  return '';
}

function tempTag(it) {
  return it.temp ? `<span class="tag temp">${esc(it.temp)}</span>` : '';
}

function casCounts() {
  const m = new Map();
  for (const it of items) if (it.cas) m.set(it.cas, (m.get(it.cas) || 0) + 1);
  return m;
}

function displayName(it) {
  if (it.name) return it.name;
  return it.status === 'processing' ? 'Reading label…' : 'Unnamed chemical';
}

async function renderRecent(freshId) {
  const el = $('#recent');
  const recent = items.slice(0, 15);
  const urls = await Promise.all(recent.map((it) => thumbUrl(it.id)));
  el.innerHTML = recent
    .map(
      (it, i) => `<button class="rcard${it.id === freshId ? ' fresh' : ''}" data-id="${it.id}">
        <img src="${urls[i]}" alt="" /><span class="s">${statusTag(it)}</span>
        <div class="t">${esc(displayName(it))}</div></button>`,
    )
    .join('');
  if (freshId) el.scrollLeft = 0;
}

function matches(it, q) {
  if (!q) return true;
  const hay = [it.name, it.cas, it.formula, it.supplier, it.catalog, it.lot, it.location, it.notes, it.iupac, it.pubchemName, it.category, it.description, it.uses, it.areas].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

async function renderLibrary() {
  const q = $('#search').value.trim();
  const sort = $('#sort').value;
  const tf = $('#temp-filter').value;
  const mode = settings.get().libraryMode;
  $('#mode-cards').classList.toggle('on', mode === 'cards');
  $('#mode-table').classList.toggle('on', mode === 'table');
  let list = items.filter((it) => matches(it, q) && (!tf || (tf === 'none' ? !it.temp : it.temp === tf)));
  const cmp = {
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    name: (a, b) => (a.name || '~').localeCompare(b.name || '~', undefined, { sensitivity: 'base' }),
    loc: (a, b) => (a.location || '~').localeCompare(b.location || '~') || (a.name || '').localeCompare(b.name || ''),
  }[sort];
  list = [...list].sort(cmp);
  const review = items.filter((i) => i.status === 'review' || i.status === 'error').length;
  $('#lib-summary').textContent = `${items.length} chemical${items.length === 1 ? '' : 's'}${review ? ` · ${review} need checking` : ''}${q ? ` · ${list.length} shown` : ''}`;
  if (!list.length) {
    $('#list').innerHTML = `<div class="empty">${items.length ? 'No matches.' : 'No chemicals scanned yet.<br>Go to Scan and start placing bottles in front of the camera.'}</div>`;
    return;
  }
  const urls = await Promise.all(list.map((it) => thumbUrl(it.id)));
  const dups = casCounts();
  const dupTag = (it) => (it.cas && dups.get(it.cas) > 1 ? `<span class="tag warn">${dups.get(it.cas)}× in lab</span>` : '');
  if (mode === 'table') {
    $('#list').innerHTML = `<div class="table-wrap"><table class="sheet-table"><thead><tr>
      <th></th><th>Name</th><th>Category</th><th>CAS</th><th>Formula</th><th>MW</th><th>Supplier</th><th>Cat #</th><th>Lot</th><th>Amount</th><th>Temp</th><th>Location</th><th>Hazard</th></tr></thead><tbody>
      ${list
        .map(
          (it, i) => `<tr data-id="${it.id}"><td><img src="${urls[i]}" alt="" loading="lazy" /></td>
          <td class="name">${esc(displayName(it))} ${statusTag(it)}${dupTag(it)}</td><td>${esc(it.category)}</td><td class="mono">${esc(it.cas)}</td><td>${esc(it.formula)}</td><td>${esc(it.mw)}</td>
          <td>${esc(it.supplier)}</td><td class="mono">${esc(it.catalog)}</td><td class="mono">${esc(it.lot)}</td><td>${esc(it.amount)}</td>
          <td>${esc(it.temp)}</td><td>${esc(it.location)}</td><td>${signalTag(it)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
    return;
  }
  $('#list').innerHTML = list
    .map((it, i) => {
      const l1 = [it.cas && `CAS ${it.cas}`, it.formula, it.mw && `${it.mw} g/mol`].filter(Boolean).join(' · ');
      const l2 = [it.supplier, it.catalog && `#${it.catalog}`, it.amount, it.purity].filter(Boolean).join(' · ');
      return `<button class="item" data-id="${it.id}">
        <img src="${urls[i]}" alt="" loading="lazy" />
        <div class="body">
          <div class="name">${esc(displayName(it))}</div>
          ${l1 ? `<div class="line">${esc(l1)}</div>` : ''}
          ${l2 ? `<div class="line">${esc(l2)}</div>` : ''}
          ${it.description ? `<div class="line desc">${esc(it.description)}</div>` : ''}
          <div class="tags">${it.category ? `<span class="tag cat">${esc(it.category)}</span>` : ''}${statusTag(it)}${signalTag(it)}${dupTag(it)}${tempTag(it)}${it.location ? `<span class="tag loc">📍 ${esc(it.location)}</span>` : ''}</div>
        </div></button>`;
    })
    .join('');
}

function renderCount() {
  $('#count-badge').textContent = items.length;
}

function updateQueueChip() {
  const n = pendingCount();
  $('#queue-chip').classList.toggle('hidden', n === 0);
  $('#queue-n').textContent = n;
}

function renderLocation() {
  const { location, temp } = settings.get();
  $('#loc-text').textContent = location || 'Set location';
  $('#temp-text').textContent = temp;
}

// ---------------------------------------------------------------- detail sheet
const FIELDS = [
  ['name', 'Name', 'wide name'],
  ['category', 'Category'],
  ['areas', 'Research areas'],
  ['description', 'Description', 'wide', 'textarea'],
  ['uses', 'Used for', 'wide', 'textarea'],
  ['cas', 'CAS number'],
  ['formula', 'Formula'],
  ['mw', 'MW (g/mol)'],
  ['amount', 'Amount'],
  ['supplier', 'Supplier'],
  ['catalog', 'Catalog #'],
  ['lot', 'Lot'],
  ['expiry', 'Expiry'],
  ['purity', 'Purity / grade', 'wide'],
  ['location', 'Location'],
  ['temp', 'Storage temp'],
  ['signal', 'GHS signal'],
  ['hazards', 'H-codes'],
  ['storage', 'Storage', 'wide'],
  ['workingConc', 'Working conc.'],
  ['stockSolution', 'Stock solution'],
  ['handling', 'Handling', 'wide', 'textarea'],
  ['notes', 'Notes', 'wide', 'textarea'],
];

let photoUrl = '';
let navIds = []; // ids in the order of the list the sheet was opened from (Library filter/sort or recent strip)
async function openDetail(id) {
  const it = items.find((i) => i.id === id) || (await getItem(id));
  if (!it) return;
  openId = id;
  auto.enabled = false;
  $('#sheet').classList.remove('hidden');
  const imgs = await getImages(id);
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = imgs?.full ? URL.createObjectURL(imgs.full) : '';
  $('#d-photo').src = photoUrl;
  fillDetail(it);
  updateNav();
}

function updateNav() {
  const i = navIds.indexOf(openId);
  $('#d-pos').textContent = i >= 0 && navIds.length > 1 ? `${i + 1} / ${navIds.length}` : '';
  $('#d-prev').disabled = i <= 0;
  $('#d-next').disabled = i < 0 || i >= navIds.length - 1;
}

/** Show the next (dir = 1) or previous (dir = -1) chemical in the list the sheet came from. */
async function step(dir) {
  const i = navIds.indexOf(openId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= navIds.length) return;
  if (dirty) {
    clearTimeout(saveTimer);
    dirty = false;
    const cur = items.find((x) => x.id === openId);
    if (cur) await putItem(cur);
  }
  document.activeElement?.blur?.();
  const body = $('.sheet-body');
  body.classList.remove('slide-l', 'slide-r');
  void body.offsetWidth; // restart the animation
  body.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
  body.scrollTop = 0;
  await openDetail(navIds[j]);
}

$('#d-prev').addEventListener('click', () => step(-1));
$('#d-next').addEventListener('click', () => step(1));

// Swipe left = next, right = previous. Ignored when the gesture starts in a text field (cursor moves)
// or is mostly vertical (scrolling).
let swipe = null;
$('#sheet').addEventListener('touchstart', (e) => {
  swipe = e.touches.length === 1 && !e.target.closest('input, textarea, select')
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }
    : null;
}, { passive: true });
$('#sheet').addEventListener('touchend', (e) => {
  if (!swipe) return;
  const dx = e.changedTouches[0].clientX - swipe.x;
  const dy = e.changedTouches[0].clientY - swipe.y;
  const fast = Date.now() - swipe.t < 800;
  swipe = null;
  if (fast && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
}, { passive: true });
document.addEventListener('keydown', (e) => {
  if (!openId || e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
});

function fillDetail(it) {
  $('#sheet-status').innerHTML = statusTag(it) || '<span class="tag ok">saved</span>';
  const alert = $('#d-alert');
  const msgs = [];
  if (it.error) msgs.push(it.error);
  if (it.status === 'review' && !it.error) msgs.push('Could not confidently identify this chemical. Check the name or type the CAS number, then tap Re-read label.');
  alert.textContent = msgs.join(' ');
  alert.classList.toggle('hidden', !msgs.length);

  const structLink = $('#d-struct-link');
  if (it.cid) {
    structLink.classList.remove('hidden');
    structLink.href = compoundPageUrl(it.cid);
    $('#d-struct').src = structureImageUrl(it.cid);
  } else structLink.classList.add('hidden');

  const cands = (it.candidates || []).filter((c) => c && c !== it.name).slice(0, 5);
  if (it.pubchemName && it.pubchemName !== it.name && !cands.includes(it.pubchemName)) cands.unshift(it.pubchemName);
  $('#d-cands').innerHTML = cands.map((c) => `<button class="cand" type="button">${esc(c)}</button>`).join('');

  const form = $('#d-form');
  const active = document.activeElement?.name;
  form.innerHTML = FIELDS.map(([k, label, cls = '', kind]) => {
    const v = esc(it[k] ?? '');
    const input = kind === 'textarea' ? `<textarea name="${k}" rows="2">${v}</textarea>` : `<input name="${k}" value="${v}" autocomplete="off" />`;
    return `<label class="${cls}">${label}${input}</label>`;
  }).join('');
  if (active) form.elements[active]?.focus();

  $('#d-hazard').innerHTML = (it.pictograms || '')
    .split(/,\s*/)
    .filter(Boolean)
    .map((p) => `<span class="picto">◆ ${esc(p)}</span>`)
    .join('');

  const meta = [];
  if (it.iupac) meta.push(`IUPAC: ${esc(it.iupac)}`);
  if (it.smiles) meta.push(`SMILES: ${esc(it.smiles)}`);
  if (it.cid) meta.push(`<a href="${compoundPageUrl(it.cid)}" target="_blank" rel="noopener">PubChem CID ${it.cid}</a>${it.matchedBy ? ` (matched by ${esc(it.matchedBy)})` : ''}`);
  if (it.barcode) meta.push(`Barcode: ${esc(it.barcode)}`);
  if (it.aboutBy === 'Claude Haiku') meta.push('Description, uses, concentrations and handling were written by Claude Haiku from general knowledge. Check before relying on them.');
  else if (it.aboutBy) meta.push('Claude did not recognize this substance, so there is no description.');
  meta.push(`Scanned ${new Date(it.createdAt).toLocaleString()}${it.engine ? ` · read by ${esc(it.engine)}` : ''}`);
  $('#d-meta').innerHTML = meta.map((m) => `<div>${m}</div>`).join('');
  $('#d-ocr').textContent = it.ocrText || '(none yet)';
  $('#d-describe').classList.toggle('hidden', !claudeReady() || !it.name || it.status === 'processing');
  $('#d-describe').textContent = it.description ? 'Rewrite description' : 'Write description';
}

const claudeReady = () => settings.get().engine === 'claude' && !!settings.get().apiKey;

async function redescribe(it) {
  for (const k of ABOUT_FIELDS) delete it[k];
  await putItem(it);
  enqueue(it.id, 'describe');
  updateQueueChip();
}

$('#d-describe').addEventListener('click', async () => {
  const it = items.find((i) => i.id === openId);
  if (!it) return;
  clearTimeout(saveTimer);
  dirty = false;
  await redescribe(it);
  fillDetail(it);
  toast('Writing description…');
});

function closeDetail() {
  openId = null;
  $('#sheet').classList.add('hidden');
  auto.enabled = settings.get().autoCapture;
  auto.markCaptured(); // don't re-capture whatever is in view right now
  if (currentView === 'library') renderLibrary();
  renderRecent();
}

let saveTimer;
let dirty = false;
$('#d-form').addEventListener('input', (e) => {
  const it = items.find((i) => i.id === openId);
  if (!it) return;
  it[e.target.name] = e.target.value;
  if (e.target.name === 'name') it.nameEdited = true;
  if (e.target.name === 'cas') it.casEdited = !!e.target.value.trim();
  it.updatedAt = new Date().toISOString();
  if (it.status === 'review' && it.name) it.status = 'done';
  clearTimeout(saveTimer);
  dirty = true;
  saveTimer = setTimeout(() => {
    dirty = false;
    putItem(it);
  }, 300);
});

$('#d-cands').addEventListener('click', async (e) => {
  const b = e.target.closest('.cand');
  const it = items.find((i) => i.id === openId);
  if (!b || !it) return;
  it.name = b.textContent;
  it.nameEdited = true;
  if (it.status === 'review') it.status = 'done';
  await putItem(it);
  fillDetail(it);
});

const AUTO_FIELDS = ['formula', 'mw', 'supplier', 'catalog', 'lot', 'amount', 'purity', 'expiry', 'signal', 'hazards', 'pictograms', 'storage', 'iupac', 'smiles', 'inchikey', 'cid', 'pubchemName', 'matchedBy', 'barcode', 'ocrText', 'candidates', 'error', 'engine', 'confidence', 'aiTokens', ...ABOUT_FIELDS];

const readerName = () => (settings.get().engine === 'claude' && settings.get().apiKey ? 'Claude Haiku' : 'on-device OCR');

/**
 * Read the photo again with the current reader and replace everything that was read automatically.
 * Kept: a name or CAS the user typed / picked, location, storage temp, notes.
 */
async function reread(it) {
  for (const k of AUTO_FIELDS) delete it[k];
  if (!it.casEdited) delete it.cas;
  if (!it.nameEdited) it.name = '';
  it.status = 'processing';
  await putItem(it);
  enqueue(it.id);
  updateQueueChip();
}

$('#d-reread').addEventListener('click', async () => {
  const it = items.find((i) => i.id === openId);
  if (!it) return;
  clearTimeout(saveTimer);
  await reread(it);
  fillDetail(it);
  toast(`Re-reading with ${readerName()}…`);
});

$('#sheet-delete').addEventListener('click', async () => {
  if (!openId || !confirm('Delete this scan and its photo?')) return;
  const id = openId;
  await deleteItem(id);
  items = items.filter((i) => i.id !== id);
  thumbUrls.delete(id);
  renderCount();
  closeDetail();
  toast('Deleted');
});

$('#sheet-close').addEventListener('click', closeDetail);
$('#d-photo').addEventListener('click', () => {
  if (!photoUrl) return;
  $('#viewer img').src = photoUrl;
  $('#viewer').classList.remove('hidden');
});
$('#viewer').addEventListener('click', () => $('#viewer').classList.add('hidden'));
window.addEventListener('popstate', () => {
  if (!$('#viewer').classList.contains('hidden')) $('#viewer').classList.add('hidden');
  else if (openId) closeDetail();
});

// ---------------------------------------------------------------- pipeline updates
onItemUpdated((updated) => {
  updateQueueChip();
  if (!updated) return;
  const idx = items.findIndex((i) => i.id === updated.id);
  if (idx === -1) return;
  // keep user edits made while the item was processing
  const local = items[idx];
  const merged = { ...updated };
  for (const k of ['location', 'notes']) if (local[k] && !updated[k]) merged[k] = local[k];
  if (local.nameEdited) {
    merged.name = local.name;
    merged.nameEdited = true;
  }
  items[idx] = merged;
  if (merged.status !== 'processing' && (merged.name !== updated.name || merged.location !== updated.location)) putItem(merged);
  renderRecent();
  if (currentView === 'library') renderLibrary();
  if (openId === updated.id) fillDetail(merged);
  if (updated.status !== 'processing' && currentView === 'scan' && !openId) {
    if (merged.name) chime();
    lastStatusOverride = performance.now() + 1800;
    setStatus(merged.name ? `✓ ${merged.name}` : '? Unrecognized — check later', merged.name ? 'ok' : 'err');
  }
});

// ---------------------------------------------------------------- navigation
function show(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'scan') startCamera();
  else stopCamera();
  if (view === 'library') renderLibrary();
  if (view === 'settings') {
    renderStorage();
    syncSettingsUI();
  }
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b && b.dataset.view !== currentView) show(b.dataset.view);
});

for (const sel of ['#recent', '#list']) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) {
      navIds = [...$(sel).querySelectorAll('[data-id]')].map((x) => x.dataset.id);
      history.pushState({ sheet: true }, '');
      openDetail(b.dataset.id);
    }
  });
}

// ---------------------------------------------------------------- scan controls
$('#btn-shutter').addEventListener('click', () => capture('manual'));
$('#btn-auto').addEventListener('click', () => {
  const on = !settings.get().autoCapture;
  settings.set({ autoCapture: on });
  syncAutoButton();
  toast(on ? 'Auto capture on — just place chemicals in view' : 'Auto capture off — tap the shutter');
});
function syncAutoButton() {
  const on = settings.get().autoCapture;
  $('#btn-auto').setAttribute('aria-pressed', String(on));
  $('#auto').checked = on;
  auto.enabled = on && !openId;
  if (on) auto.resetBackground();
  $('.hold').classList.toggle('hidden', !on);
  if (!on) {
    $('#frame').className = 'frame';
    setStatus('Tap the shutter to capture');
  }
}
$('#btn-torch').addEventListener('click', async () => {
  const b = $('#btn-torch');
  const on = b.getAttribute('aria-pressed') !== 'true';
  try {
    if (await camera.setTorch(on)) b.setAttribute('aria-pressed', String(on));
  } catch {
    toast('Flashlight not available');
  }
});
$('#btn-rebg').addEventListener('click', () => {
  auto.resetBackground();
  toast('Remove any chemical from view — learning the empty spot');
});
let batchTemp = '';
function renderTempButtons() {
  $('#batch-temp').innerHTML = ['', ...TEMPS]
    .map((t) => `<button type="button" data-t="${t}" class="${t === batchTemp ? 'on' : ''}">${t ? t.replace(' °C', '°') : 'none'}</button>`)
    .join('');
}
$('#batch-temp').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  batchTemp = b.dataset.t;
  renderTempButtons();
});
$('#loc-chip').addEventListener('click', () => {
  const s = settings.get();
  $('#batch-loc').value = s.location;
  batchTemp = s.temp;
  renderTempButtons();
  const locs = [...new Set(items.map((i) => i.location).filter(Boolean))].slice(0, 30);
  $('#loc-list').innerHTML = locs.map((l) => `<option value="${esc(l)}"></option>`).join('');
  auto.enabled = false;
  $('#batch').showModal();
});
$('#batch').addEventListener('close', () => {
  if ($('#batch').returnValue === 'save') {
    settings.set({ location: $('#batch-loc').value.trim(), temp: batchTemp });
    renderLocation();
  }
  auto.enabled = settings.get().autoCapture && !openId;
  auto.markCaptured();
});
$('#btn-start-cam').addEventListener('click', startCamera);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentView === 'scan') {
    if (!camera.running) startCamera();
    else acquireWakeLock();
  }
});

// ---------------------------------------------------------------- library controls
$('#search').addEventListener('input', renderLibrary);
$('#sort').addEventListener('change', renderLibrary);
$('#temp-filter').innerHTML = `<option value="">All temps</option>${TEMPS.map((t) => `<option>${t}</option>`).join('')}<option value="none">No temp</option>`;
$('#temp-filter').addEventListener('change', renderLibrary);
$('#mode-cards').addEventListener('click', () => {
  settings.set({ libraryMode: 'cards' });
  renderLibrary();
});
$('#mode-table').addEventListener('click', () => {
  settings.set({ libraryMode: 'table' });
  renderLibrary();
});
$('#btn-html').addEventListener('click', async () => {
  if (!items.length) return toast('Nothing to export yet');
  const b = $('#btn-html');
  b.disabled = true;
  try {
    await exportCatalog((i, n) => (b.textContent = `Preparing ${i}/${n}…`));
  } catch (e) {
    toast(`Export failed: ${e.message}`);
  } finally {
    b.disabled = false;
    b.textContent = 'Offline catalog';
  }
});
$('#btn-csv').addEventListener('click', async () => {
  if (!items.length) return toast('Nothing to export yet');
  await exportCSV();
});
$('#btn-zip').addEventListener('click', async () => {
  if (!items.length) return toast('Nothing to export yet');
  const b = $('#btn-zip');
  b.disabled = true;
  try {
    await exportZIP((i, n) => (b.textContent = `Packing ${Math.round((100 * i) / n)}%…`));
  } catch (e) {
    toast(`Export failed: ${e.message}`);
  } finally {
    b.disabled = false;
    b.textContent = 'ZIP + photos';
  }
});

// ---------------------------------------------------------------- settings
function initSettings() {
  const s = settings.get();
  $('#pubchem').checked = s.pubchem;
  for (const r of document.querySelectorAll('input[name=engine]')) r.checked = r.value === s.engine;
  $('#api-key').value = s.apiKey;
  $('#auto').checked = s.autoCapture;
  $('#sens').value = s.sensitivity;
  $('#hold').value = s.holdMs;
  $('#beep').checked = s.beep;
  syncSettingsUI();
}

function syncSettingsUI() {
  const s = settings.get();
  $('#sens-val').textContent = { 1: '(low)', 2: '(normal)', 3: '(high)' }[s.sensitivity];
  $('#hold-val').textContent = `${(s.holdMs / 1000).toFixed(1)} s`;
  auto.setSensitivity(Number(s.sensitivity));
  auto.holdMs = Number(s.holdMs);
  const useClaude = s.engine === 'claude';
  $('#claude-opts').classList.toggle('hidden', !useClaude);
  const u = s.usage || {};
  $('#usage-info').textContent = u.calls
    ? `${u.calls} label${u.calls === 1 ? '' : 's'} read by Claude on this phone, about $${costOf(u).toFixed(u.calls < 100 ? 4 : 2)} in total.`
    : '';
  // OCR is also the offline fallback for Claude, but only download it up front when it's the main reader
  if (!useClaude || !s.apiKey) preloadOCR();
}

$('#view-settings').addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'engine') settings.set({ engine: t.value });
  else if (t.id === 'api-key') settings.set({ apiKey: t.value.trim() });
  else if (t.id === 'pubchem') settings.set({ pubchem: t.checked });
  else if (t.id === 'auto') {
    settings.set({ autoCapture: t.checked });
    syncAutoButton();
  } else if (t.id === 'sens') settings.set({ sensitivity: Number(t.value) });
  else if (t.id === 'hold') settings.set({ holdMs: Number(t.value) });
  else if (t.id === 'beep') settings.set({ beep: t.checked });
  else if (t.id === 'import') return;
  syncSettingsUI();
});
$('#view-settings').addEventListener('input', (e) => {
  if (e.target.type === 'range') {
    settings.set({ [e.target.id === 'sens' ? 'sensitivity' : 'holdMs']: Number(e.target.value) });
    syncSettingsUI();
  }
});

async function renderStorage() {
  let txt = `${items.length} scans stored on this device.`;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage) txt += ` Using ${(est.usage / 1e6).toFixed(1)} MB${est.quota ? ` of ${(est.quota / 1e9).toFixed(1)} GB available` : ''}.`;
  } catch {
    /* ignore */
  }
  $('#storage-info').textContent = txt;
}

$('#import').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const n = await importZIP(f, makeThumb);
    await loadItems();
    toast(`Imported ${n} chemicals`);
    renderStorage();
  } catch (err) {
    toast(`Import failed: ${err.message}`, 4000);
  }
});

$('#btn-test-key').addEventListener('click', async (e) => {
  const key = $('#api-key').value.trim();
  if (!key) return toast('Paste your API key first');
  settings.set({ apiKey: key });
  e.target.disabled = true;
  try {
    const name = await testKey(key);
    toast(`Key works: ${name} is available`);
  } catch (err) {
    toast(describeError(err), 5000);
  } finally {
    e.target.disabled = false;
  }
});

$('#btn-retry').addEventListener('click', async () => {
  const todo = items.filter((i) => i.status === 'review' || i.status === 'error');
  if (!todo.length) return toast('Nothing to re-read');
  for (const it of todo) await reread(it);
  toast(`Re-reading ${todo.length} scan${todo.length === 1 ? '' : 's'} with ${readerName()}…`);
});

$('#btn-describe-all').addEventListener('click', async () => {
  if (!claudeReady()) return toast('Choose Claude Haiku and add an API key above first', 4000);
  // only identified items: notes for a wrong identity would be wrong
  const todo = items.filter((i) => i.status === 'done' && i.name && !i.description && !i.aboutBy);
  if (!todo.length) return toast('Every identified scan already has a description');
  const est = costOf({ inTok: 700 * todo.length, outTok: 350 * todo.length });
  if (!confirm(`Ask Claude Haiku to describe ${todo.length} compounds (${est < 0.01 ? 'under 1 cent' : `about $${est.toFixed(2)}`})? Only names and CAS numbers are sent, no photos.`)) return;
  for (const it of todo) enqueue(it.id, 'describe');
  updateQueueChip();
  toast(`Writing ${todo.length} descriptions…`);
});

$('#btn-reread-all').addEventListener('click', async () => {
  const todo = items.filter((i) => i.status !== 'processing');
  if (!todo.length) return toast('Nothing to re-read');
  const reader = readerName();
  const est = costOf({ inTok: 1900 * todo.length, outTok: 250 * todo.length });
  const cost = reader === 'Claude Haiku' ? ` (${est < 0.01 ? 'under 1 cent' : `about $${est.toFixed(2)}`})` : '';
  if (!confirm(`Re-read all ${todo.length} scans with ${reader}${cost}? Results read before are replaced; names and CAS numbers you typed are kept.`)) return;
  for (const it of todo) await reread(it);
  renderLibrary();
  toast(`Re-reading ${todo.length} scans with ${reader}…`);
});

$('#btn-clear').addEventListener('click', async () => {
  if (!items.length) return;
  if (!confirm(`Delete all ${items.length} scans and photos from this device? Export first if you need them.`)) return;
  if (prompt('Type DELETE to confirm') !== 'DELETE') return;
  await clearAll();
  thumbUrls.forEach((u) => u && URL.revokeObjectURL(u));
  thumbUrls.clear();
  items = [];
  renderCount();
  renderRecent();
  renderStorage();
  toast('All scans deleted');
});

// ---------------------------------------------------------------- boot
async function loadItems() {
  items = (await allItems()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  renderCount();
  renderRecent();
  // resume anything interrupted (app closed mid-recognition)
  for (const it of [...items].reverse()) if (it.status === 'processing') enqueue(it.id);
  updateQueueChip();
}

initSettings();
syncAutoButton();
renderLocation();
requestPersistence();
loadItems();
startCamera();
