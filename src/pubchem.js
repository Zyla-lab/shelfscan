// PubChem PUG-REST lookups (free, CORS-enabled, no key). Used to turn a CAS number or a
// guessed name into a canonical compound record.

const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest';

async function getJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function cidFor(query) {
  if (!query) return null;
  const j = await getJSON(`${BASE}/pug/compound/name/${encodeURIComponent(query)}/cids/JSON`);
  return j?.IdentifierList?.CID?.[0] ?? null;
}

export async function properties(cid) {
  const j = await getJSON(
    `${BASE}/pug/compound/cid/${cid}/property/Title,IUPACName,MolecularFormula,MolecularWeight,SMILES,InChIKey/JSON`,
  );
  const p = j?.PropertyTable?.Properties?.[0];
  if (!p) return null;
  return {
    cid,
    title: p.Title || '',
    iupac: p.IUPACName || '',
    formula: p.MolecularFormula || '',
    mw: p.MolecularWeight ? String(p.MolecularWeight) : '',
    smiles: p.SMILES || p.CanonicalSMILES || p.ConnectivitySMILES || '',
    inchikey: p.InChIKey || '',
  };
}

const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

export async function casFor(cid) {
  const j = await getJSON(`${BASE}/pug/compound/cid/${cid}/synonyms/JSON`);
  const syn = j?.InformationList?.Information?.[0]?.Synonym || [];
  return syn.find((s) => CAS_RE.test(s)) || '';
}

function walk(sections, visit) {
  for (const s of sections || []) {
    for (const info of s.Information || []) visit(info);
    walk(s.Section, visit);
  }
}

/**
 * GHS classification. PubChem lists several sources per compound; the ECHA C&L aggregate is
 * preferred because it reports what fraction of notifiers use each hazard statement. Minority
 * statements (<50% of reports) are dropped so e.g. sodium chloride isn't flagged "Danger".
 */
export async function ghs(cid) {
  const j = await getJSON(`${BASE}/pug_view/data/compound/${cid}/JSON?heading=GHS+Classification`, 10000);
  if (!j?.Record) return null;
  const groups = new Map();
  walk(j.Record.Section, (info) => {
    const ref = info.ReferenceNumber ?? 0;
    if (!groups.has(ref)) groups.set(ref, { signal: '', pictos: new Set(), hazards: [], notMet: 0, echa: false });
    const g = groups.get(ref);
    const swm = info.Value?.StringWithMarkup || [];
    if (info.Name === 'Signal' && !g.signal) g.signal = swm[0]?.String || '';
    if (info.Name === 'Pictogram(s)') for (const s of swm) for (const m of s.Markup || []) if (m.Extra) g.pictos.add(m.Extra);
    if (info.Name === 'GHS Hazard Statements') {
      for (const s of swm) {
        const m = /^(H\d{3}[A-Za-z+H\d]*)(?:\s*\((\d+(?:\.\d+)?)%\))?/.exec(s.String || '');
        if (m) g.hazards.push({ code: m[1], pct: m[2] ? Number(m[2]) : null });
      }
    }
    if (info.Name === 'ECHA C&L Notifications Summary') g.echa = true;
    if (info.Name === 'Note') {
      const m = /does not meet GHS hazard criteria for (\d+(?:\.\d+)?)%/.exec(swm[0]?.String || '');
      if (m) g.notMet = Number(m[1]);
    }
  });
  const all = [...groups.values()];
  const g = all.find((x) => x.echa) || all.find((x) => x.hazards.length || x.signal);
  if (!g) return null;
  if (g.notMet >= 50) return { signal: '', pictograms: [], hazards: [], note: `Not GHS-classified in ${g.notMet}% of ECHA reports` };
  const hazards = [...new Set(g.hazards.filter((h) => h.pct == null || h.pct >= 50).map((h) => h.code))].sort();
  if (!hazards.length) return { signal: '', pictograms: [], hazards: [] };
  return { signal: g.signal, pictograms: [...g.pictos], hazards };
}

export function structureImageUrl(cid) {
  return `${BASE}/pug/compound/cid/${cid}/PNG?image_size=300x300`;
}

export function compoundPageUrl(cid) {
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
}

/**
 * Resolve a compound from whatever we have. Tries CAS numbers first (most reliable),
 * then name candidates in order. Returns null if nothing resolves.
 */
export async function resolve({ casList = [], names = [] }) {
  let cid = null;
  let matchedBy = '';
  let matchedCas = '';
  for (const cas of casList) {
    cid = await cidFor(cas);
    if (cid) { matchedBy = `CAS ${cas}`; matchedCas = cas; break; }
  }
  if (!cid) {
    for (const n of names.slice(0, 4)) {
      if (!n || n.length < 3) continue;
      cid = await cidFor(n);
      if (cid) { matchedBy = `name "${n}"`; break; }
    }
  }
  if (!cid) return null;
  const [props, hz, cas] = await Promise.all([properties(cid), ghs(cid), matchedCas ? Promise.resolve(matchedCas) : casFor(cid)]);
  if (!props) return null;
  return { ...props, cas, ghs: hz, matchedBy };
}
