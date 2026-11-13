// Self-contained offline catalog: one HTML file with the data and photos embedded and a small
// viewer (search, filters, cards/table, detail with swipe, print). Opens in any browser, offline,
// with no app, server or library, so it can sit in a lab archive and stay readable.

/**
 * @param {object} d
 * @param {string} d.title
 * @param {string} d.exportedAt ISO date
 * @param {object[]} d.items
 * @param {Record<string,string>} d.thumbs  id -> small JPEG data URL (lists, print)
 * @param {Record<string,string>} d.photos  id -> larger JPEG data URL (detail view)
 * @param {Record<string,string>} d.full    id -> relative path of the full-resolution photo (ZIP only)
 */
export function viewerHTML(d) {
  // "<" escaped so text like "</script>" inside the data can't end the script element
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(d.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="app">
  <header class="top">
    <div>
      <h1>${esc(d.title)}</h1>
      <div class="muted small" id="summary"></div>
    </div>
    <button id="print" class="btn" type="button">Print</button>
  </header>
  <div class="toolbar">
    <input id="q" type="search" placeholder="Search name, CAS, use, location…" autocomplete="off">
    <select id="f-cat"><option value="">All categories</option></select>
    <select id="f-loc"><option value="">All locations</option></select>
    <select id="f-temp"><option value="">All temps</option></select>
    <select id="sort">
      <option value="name">Name A–Z</option>
      <option value="cat">Category</option>
      <option value="loc">Location</option>
      <option value="new">Newest</option>
    </select>
    <div class="seg"><button id="m-cards" type="button">Cards</button><button id="m-table" type="button">Table</button></div>
  </div>
  <main id="list"></main>
  <footer class="muted small">Exported from ShelfScan on <span id="exported"></span>. Descriptions, uses and concentrations were written by Claude from general knowledge; check them before relying on them.</footer>
</div>
<div id="print-area"></div>
<div id="detail" hidden>
  <div class="d-bar">
    <button id="d-close" class="link" type="button">← Back</button>
    <span class="d-nav"><button id="d-prev" class="link" type="button" aria-label="Previous">‹</button><span id="d-pos" class="muted small"></span><button id="d-next" class="link" type="button" aria-label="Next">›</button></span>
  </div>
  <div id="d-body"></div>
</div>
<script type="application/json" id="shelfscan-data">${json}</script>
<script>(${runtime.toString()})();</script>
</body>
</html>`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{--bg:#f4f6f9;--surface:#fff;--surface-2:#eef1f5;--text:#0f1726;--muted:#5b6678;--border:#dde2ea;--accent:#0e7c6b;--accent-soft:#d9f1ec;--danger:#c62f2f;--danger-soft:#fde4e4;--warn:#b26a00;--warn-soft:#fff0d6}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--surface:#131c2e;--surface-2:#1b2740;--text:#e8edf5;--muted:#93a0b5;--border:#24324d;--accent:#3cc2a8;--accent-soft:#12352f;--danger:#ff7676;--danger-soft:#3a1d22;--warn:#ffb44d;--warn-soft:#3a2a12}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
#app{max-width:1200px;margin:0 auto;padding:16px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
h1{font-size:22px;margin:0}
.muted{color:var(--muted)}.small{font-size:13px}
.btn{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:10px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
.link{background:none;border:0;color:var(--accent);font:inherit;font-weight:600;cursor:pointer;padding:6px 0}
.link:disabled{opacity:.25;cursor:default}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.toolbar input,.toolbar select{font:inherit;font-size:14px;padding:9px 10px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);min-width:0}
.toolbar input{flex:1 1 220px}
.toolbar select{flex:1 1 130px}
.seg{display:flex;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.seg button{border:0;background:var(--surface);color:var(--muted);font:inherit;font-size:14px;font-weight:600;padding:8px 12px;cursor:pointer}
.seg button.on{background:var(--accent);color:#fff}
#list.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
.card{display:flex;gap:12px;text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:10px;color:inherit;font:inherit;cursor:pointer;min-width:0}
.card img{flex:none;width:84px;height:100px;object-fit:cover;border-radius:10px;background:var(--surface-2)}
.card .b{min-width:0;flex:1}
.card .n{font-weight:700;font-size:16px}
.card .l{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .desc{font-size:13px;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--surface-2);color:var(--muted)}
.tag.cat{background:var(--accent-soft);color:var(--accent)}
.tag.danger{background:var(--danger-soft);color:var(--danger)}
.tag.warn{background:var(--warn-soft);color:var(--warn)}
.empty{padding:40px;text-align:center;color:var(--muted)}
.tw{overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:14px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);padding:8px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr{cursor:pointer}
td img{width:48px;height:56px;object-fit:cover;border-radius:6px;display:block}
td .s{color:var(--muted);font-size:12px}
.m{font-family:ui-monospace,Menlo,Consolas,monospace}
footer{margin:20px 0 8px}
#detail{position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:5}
#detail[hidden]{display:none}
.d-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)}
.d-nav{display:flex;align-items:center}
.d-nav .link{font-size:28px;line-height:1;padding:0 12px}
#d-pos{min-width:60px;text-align:center}
#d-body{flex:1;overflow-y:auto;padding:16px;max-width:900px;width:100%;margin:0 auto}
#d-body.sl{animation:sl .18s ease-out}#d-body.sr{animation:sr .18s ease-out}
@keyframes sl{from{transform:translateX(40px);opacity:.3}}@keyframes sr{from{transform:translateX(-40px);opacity:.3}}
.photos{display:flex;gap:10px;margin-bottom:12px}
.photos .ph{flex:1;min-width:0;max-height:52vh;object-fit:contain;border-radius:12px;background:#05080f}
.photos .st{flex:none;width:32%;max-width:180px;aspect-ratio:1;object-fit:contain;background:#fff;border-radius:12px;align-self:flex-start}
h2{font-size:22px;margin:4px 0}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:18px 0 6px}
dl{display:grid;grid-template-columns:minmax(110px,30%) 1fr;gap:6px 12px;margin:0;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px}
dt{color:var(--muted);font-size:13px}dd{margin:0;word-break:break-word}
.links{display:flex;flex-wrap:wrap;gap:14px;font-size:14px;margin:4px 0}
.links a{color:var(--accent)}
#print-area{display:none}
@media (max-width:520px){#app{padding:12px}.toolbar select{flex:1 1 40%}.card img{width:72px;height:88px}dl{grid-template-columns:1fr}dt{margin-top:4px}}
@media print{
  body{background:#fff;color:#000}
  #app,#detail{display:none!important}
  #print-area{display:block}
  #print-area h1{font-size:18px}
  #print-area table{font-size:11px}
  #print-area th{color:#000;border-bottom:2px solid #000}
  #print-area tr{page-break-inside:avoid}
  #print-area img{width:44px;height:52px;object-fit:cover}
}
`;

// Runs inside the exported file. Must not reference anything outside this function.
function runtime() {
  const D = JSON.parse(document.getElementById('shelfscan-data').textContent);
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const items = D.items;
  const byId = new Map(items.map((it) => [it.id, it]));
  const GROUPS = [
    ['About', [['category', 'Category'], ['areas', 'Research areas'], ['description', 'Description'], ['uses', 'Used for'], ['workingConc', 'Working concentration'], ['stockSolution', 'Stock solution'], ['handling', 'Handling']]],
    ['Identity', [['cas', 'CAS'], ['formula', 'Formula'], ['mw', 'MW (g/mol)'], ['iupac', 'IUPAC name'], ['smiles', 'SMILES'], ['inchikey', 'InChIKey']]],
    ['Container', [['supplier', 'Supplier'], ['catalog', 'Catalog #'], ['lot', 'Lot'], ['amount', 'Amount'], ['purity', 'Purity / grade / conc.'], ['expiry', 'Expiry'], ['barcode', 'Barcode']]],
    ['Storage and safety', [['location', 'Location'], ['temp', 'Storage temp'], ['storage', 'Storage'], ['signal', 'GHS signal'], ['hazards', 'H-codes'], ['pictograms', 'GHS pictograms']]],
    ['Notes', [['notes', 'Notes']]],
  ];
  const store = {
    get(k) { try { return localStorage.getItem('shelfscan-viewer.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('shelfscan-viewer.' + k, v); } catch { /* private mode */ } },
  };
  let mode = store.get('mode') || 'cards';
  let view = [];
  let openIdx = -1;

  $('#exported').textContent = new Date(D.exportedAt).toLocaleString();
  for (const [sel, key] of [['#f-cat', 'category'], ['#f-loc', 'location'], ['#f-temp', 'temp']]) {
    const vals = [...new Set(items.map((i) => i[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    $(sel).insertAdjacentHTML('beforeend', vals.map((v) => `<option>${esc(v)}</option>`).join(''));
    if (!vals.length) $(sel).hidden = true;
  }

  const sigTag = (it) => (/danger/i.test(it.signal) ? '<span class="tag danger">Danger</span>' : /warn/i.test(it.signal) ? '<span class="tag warn">Warning</span>' : '');
  const name = (it) => it.name || 'Unnamed';

  function filtered() {
    const words = $('#q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const cat = $('#f-cat').value, loc = $('#f-loc').value, temp = $('#f-temp').value;
    const list = items.filter((it) => {
      if (cat && it.category !== cat) return false;
      if (loc && it.location !== loc) return false;
      if (temp && it.temp !== temp) return false;
      if (!words.length) return true;
      const hay = Object.values(it).join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const by = (k) => (a, b) => (a[k] || '~').localeCompare(b[k] || '~', undefined, { sensitivity: 'base' }) || name(a).localeCompare(name(b));
    const cmp = { name: by('name'), cat: by('category'), loc: by('location'), new: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') }[$('#sort').value];
    return list.sort(cmp);
  }

  function tableHTML(list) {
    return `<table><thead><tr><th></th><th>Name</th><th>Category</th><th>CAS</th><th>Supplier / Cat #</th><th>Amount</th><th>Location / Temp</th><th>Hazard</th></tr></thead><tbody>${list
      .map((it, i) => `<tr data-i="${i}"><td>${D.thumbs[it.id] ? `<img src="${D.thumbs[it.id]}" alt="" decoding="async">` : ''}</td>
        <td><b>${esc(name(it))}</b><div class="s">${esc([it.formula, it.mw && it.mw + ' g/mol'].filter(Boolean).join(' · '))}</div></td>
        <td>${esc(it.category)}</td><td class="m">${esc(it.cas)}</td>
        <td>${esc(it.supplier)}<div class="s m">${esc(it.catalog)}</div></td>
        <td>${esc(it.amount)}<div class="s">${esc(it.purity)}</div></td>
        <td>${esc(it.location)}<div class="s">${esc(it.temp)}</div></td>
        <td>${esc(it.signal)}<div class="s">${esc(it.hazards)}</div></td></tr>`)
      .join('')}</tbody></table>`;
  }

  function render() {
    view = filtered();
    $('#summary').textContent = `${items.length} containers${view.length !== items.length ? ` · ${view.length} shown` : ''}`;
    $('#m-cards').classList.toggle('on', mode === 'cards');
    $('#m-table').classList.toggle('on', mode === 'table');
    const el = $('#list');
    el.className = mode;
    if (!view.length) {
      el.innerHTML = '<div class="empty">No matches.</div>';
      return;
    }
    if (mode === 'table') {
      el.innerHTML = `<div class="tw">${tableHTML(view)}</div>`;
      return;
    }
    el.innerHTML = view
      .map((it, i) => {
        const l1 = [it.cas && 'CAS ' + it.cas, it.formula, it.mw && it.mw + ' g/mol'].filter(Boolean).join(' · ');
        const l2 = [it.supplier, it.amount, it.purity].filter(Boolean).join(' · ');
        return `<button class="card" type="button" data-i="${i}">${D.thumbs[it.id] ? `<img src="${D.thumbs[it.id]}" alt="" decoding="async">` : '<img alt="">'}
          <div class="b"><div class="n">${esc(name(it))}</div>
          ${l1 ? `<div class="l">${esc(l1)}</div>` : ''}${l2 ? `<div class="l">${esc(l2)}</div>` : ''}
          ${it.description ? `<div class="desc">${esc(it.description)}</div>` : ''}
          <div class="tags">${it.category ? `<span class="tag cat">${esc(it.category)}</span>` : ''}${sigTag(it)}${it.temp ? `<span class="tag">${esc(it.temp)}</span>` : ''}${it.location ? `<span class="tag">📍 ${esc(it.location)}</span>` : ''}</div></div></button>`;
      })
      .join('');
  }

  function show(i, dir) {
    openIdx = i;
    const it = view[i];
    const body = $('#d-body');
    const groups = GROUPS.map(([title, fields]) => {
      const rows = fields.filter(([k]) => it[k]).map(([k, label]) => `<dt>${label}</dt><dd${['cas', 'smiles', 'inchikey', 'catalog', 'lot'].includes(k) ? ' class="m"' : ''}>${esc(it[k])}</dd>`);
      return rows.length ? `<h3>${title}</h3><dl>${rows.join('')}</dl>` : '';
    }).join('');
    const links = [
      it.cid && `<a href="https://pubchem.ncbi.nlm.nih.gov/compound/${encodeURIComponent(it.cid)}" target="_blank" rel="noopener">PubChem CID ${esc(it.cid)}</a>`,
      D.full[it.id] && `<a href="${esc(D.full[it.id])}" target="_blank">Full-resolution photo</a>`,
    ].filter(Boolean);
    body.innerHTML = `<div class="photos">${D.photos[it.id] || D.thumbs[it.id] ? `<img class="ph" src="${D.photos[it.id] || D.thumbs[it.id]}" alt="Container photo">` : ''}
      ${it.cid ? `<img class="st" alt="Structure" src="https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${encodeURIComponent(it.cid)}/PNG?image_size=300x300" onerror="this.remove()">` : ''}</div>
      <h2>${esc(name(it))}</h2>${links.length ? `<div class="links">${links.join('')}</div>` : ''}${groups}
      <p class="muted small">Scanned ${it.createdAt ? esc(new Date(it.createdAt).toLocaleString()) : '—'}</p>`;
    body.classList.remove('sl', 'sr');
    if (dir) {
      void body.offsetWidth;
      body.classList.add(dir > 0 ? 'sl' : 'sr');
    }
    body.scrollTop = 0;
    $('#d-pos').textContent = `${i + 1} / ${view.length}`;
    $('#d-prev').disabled = i <= 0;
    $('#d-next').disabled = i >= view.length - 1;
    $('#detail').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function open(i) {
    history.pushState({ d: 1 }, '', '#' + encodeURIComponent(view[i].id));
    show(i);
  }
  function step(dir) {
    const j = openIdx + dir;
    if (openIdx < 0 || j < 0 || j >= view.length) return;
    history.replaceState({ d: 1 }, '', '#' + encodeURIComponent(view[j].id));
    show(j, dir);
  }
  function close() {
    $('#detail').hidden = true;
    document.body.style.overflow = '';
    openIdx = -1;
  }

  $('#list').addEventListener('click', (e) => {
    const t = e.target.closest('[data-i]');
    if (t) open(Number(t.dataset.i));
  });
  $('#d-close').addEventListener('click', () => (history.state?.d ? history.back() : close()));
  $('#d-prev').addEventListener('click', () => step(-1));
  $('#d-next').addEventListener('click', () => step(1));
  window.addEventListener('popstate', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const i = view.findIndex((it) => it.id === id);
    if (i >= 0) show(i);
    else close();
  });
  document.addEventListener('keydown', (e) => {
    if (openIdx < 0) return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'Escape') $('#d-close').click();
  });
  let sw = null;
  $('#detail').addEventListener('touchstart', (e) => {
    sw = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }, { passive: true });
  $('#detail').addEventListener('touchend', (e) => {
    if (!sw) return;
    const dx = e.changedTouches[0].clientX - sw.x;
    const dy = e.changedTouches[0].clientY - sw.y;
    const ok = Date.now() - sw.t < 800 && Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy);
    sw = null;
    if (ok) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  for (const id of ['#q', '#f-cat', '#f-loc', '#f-temp', '#sort']) $(id).addEventListener('input', render);
  $('#m-cards').addEventListener('click', () => { mode = 'cards'; store.set('mode', mode); render(); });
  $('#m-table').addEventListener('click', () => { mode = 'table'; store.set('mode', mode); render(); });

  // Print = a compact table of what is currently shown (search and filters apply)
  const fillPrint = () => {
    $('#print-area').innerHTML = `<h1>${esc(document.title)}</h1><p>${view.length} containers · exported ${esc(new Date(D.exportedAt).toLocaleDateString())}</p>${tableHTML(view)}`;
  };
  window.addEventListener('beforeprint', fillPrint);
  $('#print').addEventListener('click', () => {
    fillPrint();
    window.print();
  });

  render();
  // deep link: catalog.html#<id>
  const start = decodeURIComponent(location.hash.slice(1));
  const si = view.findIndex((it) => it.id === start);
  if (si >= 0) show(si);
}
