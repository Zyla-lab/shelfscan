// Pure text heuristics: turn raw OCR text from a chemical label into structured fields.
// No DOM / network here so it can be unit-tested in Node.

export const SUPPLIERS = [
  ['MilliporeSigma', /millipore\s*sigma/i],
  ['Sigma-Aldrich', /sigma[\s-]*aldrich|sigma\b|aldrich\b|supelco/i],
  ['Merck', /\bmerck\b/i],
  ['Thermo Fisher Scientific', /thermo\s*(fisher|scientific)|\bfisher\s*(scientific|chemical|bioreagents)?\b/i],
  ['Alfa Aesar', /alfa\s*aesar/i],
  ['Acros Organics', /acros/i],
  ['TCI', /\bTCI\b|tokyo\s*chemical/i],
  ['VWR / Avantor', /\bVWR\b|avantor/i],
  ['J.T. Baker', /j\.?\s*t\.?\s*baker/i],
  ['Honeywell / Fluka', /honeywell|fluka|riedel/i],
  ['Cayman Chemical', /cayman/i],
  ['Santa Cruz Biotechnology', /santa\s*cruz/i],
  ['Combi-Blocks', /combi[\s-]*blocks/i],
  ['Oakwood Chemical', /oakwood/i],
  ['Strem', /\bstrem\b/i],
  ['Spectrum Chemical', /spectrum\s*chem/i],
  ['Chem-Impex', /chem[\s-]*impex/i],
  ['Enamine', /enamine/i],
  ['AK Scientific', /ak\s*scientific/i],
  ['GoldBio', /gold\s*bio/i],
  ['RPI', /research\s*products\s*international|\bRPI\b/i],
  ['Invitrogen', /invitrogen/i],
  ['Bio-Rad', /bio[\s-]*rad/i],
  ['Roche', /\broche\b/i],
  ['Carl Roth', /carl\s*roth|\broth\b/i],
  ['Fluorochem', /fluorochem/i],
  ['Apollo Scientific', /apollo\s*sci/i],
  ['abcr', /\babcr\b/i],
  ['BLD Pharm', /\bBLD\b|bldpharm/i],
  ['Ambeed', /ambeed/i],
  ['MedChemExpress', /medchem\s*express|\bMCE\b/i],
  ['Selleck', /selleck/i],
  ['Tocris', /tocris/i],
  ['EMD', /\bEMD\b/i],
  ['Macron', /macron/i],
  ['Mallinckrodt', /mallinckrodt/i],
  ['Beantown Chemical', /beantown/i],
  ['Matrix Scientific', /matrix\s*scientific/i],
  ['Frontier Scientific', /frontier\s*sci/i],
  ['Gelest', /gelest/i],
  ['Cambridge Isotope Labs', /cambridge\s*isotope/i],
];

const GRADE_WORDS = [
  'ACS reagent', 'ACS', 'ReagentPlus', 'ReagentPlus®', 'BioReagent', 'BioUltra', 'BioXtra', 'HPLC',
  'HPLC grade', 'LC-MS', 'LC/MS', 'Optima', 'anhydrous', 'puriss', 'p.a.', 'USP', 'NF', 'EP', 'FCC',
  'molecular biology', 'cell culture', 'spectrophotometric', 'certified', 'technical', 'Certified ACS',
  'SAJ', 'GR', 'AR', 'Electrophoresis', 'Ultrapure', 'TraceSELECT', 'Emsure', 'Suprapur',
];

const UNIT_MAP = { ml: 'mL', l: 'L', ul: 'µL', 'µl': 'µL', mg: 'mg', g: 'g', kg: 'kg', ug: 'µg', 'µg': 'µg', oz: 'oz', lb: 'lb', gal: 'gal', mmol: 'mmol', mol: 'mol' };

// Lines that are almost never the chemical name.
const BOILERPLATE = /(www\.|\.com|http|tel|phone|fax|lot|batch|cat\.?\s*no|catalog|product\s*(no|number)|cas\b|store|storage|keep|danger|warning|caution|hazard|harmful|toxic|flammable|corrosive|irritant|precaution|made in|manufactured|distributed|for research|research use|not for|use only|exp(iry|iration)?\b|mfg|date|net\s*(wt|weight|contents)|formula|mol(ecular)?\.?\s*w|m\.?w\.?|f\.?w\.?|assay|purity|grade|spec|inc\.?\b|ltd|gmbh|llc|co\.\b|usa|germany|st\.?\s*louis|missouri|darmstadt|waltham|pittsburgh|madison|eu\b|un\s*\d|sds|msds|see\s|label|bottle|ghs|p\d{3}|h\d{3}|barcode|qty|quantity|size|pkg)/i;

export function casChecksumOk(cas) {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(cas);
  if (!m) return false;
  const digits = (m[1] + m[2]).split('').reverse();
  const sum = digits.reduce((acc, d, i) => acc + Number(d) * (i + 1), 0);
  return sum % 10 === Number(m[3]);
}

// OCR commonly confuses these glyphs inside numeric tokens.
function fixDigits(s) {
  return s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
}

export function findCasNumbers(text) {
  const found = [];
  const re = /([0-9OoIlSB]{2,7})\s*[-–—~]\s*([0-9OoIlSB]{2})\s*[-–—~]\s*([0-9OoIlSB])(?![0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const cas = `${fixDigits(m[1])}-${fixDigits(m[2])}-${fixDigits(m[3])}`.replace(/^0+(?=\d{2,}-)/, '');
    if (casChecksumOk(cas) && !found.includes(cas)) {
      // Prefer CAS numbers explicitly labelled "CAS"
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/cas/i.test(before)) found.unshift(cas);
      else found.push(cas);
    }
  }
  return found;
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1].trim();
  }
  return '';
}

export function findCatalog(text) {
  return firstMatch(text, [
    /(?:cat(?:alog(?:ue)?)?\.?\s*(?:no\.?|#|number|num)|product\s*(?:no\.?|#|number|code)|prod\.?\s*(?:no\.?|#)|art(?:ikel|icle)?\.?\s*(?:no\.?|nr\.?|#)|item\s*(?:no\.?|#)|ref\.?\s*(?:no\.?|#)?|sku)\s*[:.#]?\s*([A-Z0-9][A-Z0-9\-./]{2,20})/i,
  ]).replace(/[.,]$/, '');
}

export function findLot(text) {
  return firstMatch(text, [
    /(?:lot|batch|charge|ch\.-?b\.?)\s*(?:no\.?|#|number|nr\.?)?\s*[:.#]?\s*([A-Z0-9][A-Z0-9\-]{2,20})/i,
  ]);
}

export function findAmount(text) {
  const re = /(\d+(?:[.,]\d+)?)\s?(mg|kg|g|mL|ml|µL|µl|uL|ul|L|l|µg|ug|mmol|mol|oz|lb|gal)\b/g;
  let best = '';
  let m;
  while ((m = re.exec(text))) {
    const unit = UNIT_MAP[m[2].toLowerCase()] || m[2];
    // Skip things that are likely concentrations ("1 g/L") or MW ("58.44 g/mol")
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 4);
    if (/^\s*\//.test(after)) continue;
    const val = `${m[1].replace(',', '.')} ${unit}`;
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (/net|contents|qty|quantity|size|pack/i.test(before)) return val;
    if (!best) best = val;
  }
  return best;
}

export function findPurity(text) {
  const parts = [];
  const pm = /(≥|>=|>|min\.?|minimum)?\s*(\d{2}(?:[.,]\d{1,3})?)\s?%/i.exec(text);
  if (pm && Number(pm[2].replace(',', '.')) >= 50) parts.push(`${pm[1] ? (pm[1].startsWith('m') ? '≥' : pm[1].replace('>=', '≥')) : ''}${pm[2].replace(',', '.')}%`);
  for (const g of [...GRADE_WORDS].sort((a, b) => b.length - a.length)) {
    if (parts.some((p) => p.toLowerCase().includes(g.toLowerCase()))) continue;
    const esc = g.replace(/[.*+?^${}()|[\]\\®]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z])${esc}($|[^A-Za-z])`, g.length <= 3 ? '' : 'i').test(text) && !parts.some((p) => p.toLowerCase().includes(g.toLowerCase()))) {
      parts.push(g);
      if (parts.length >= 3) break;
    }
  }
  return parts.join(', ');
}

export function findMW(text) {
  return firstMatch(text, [
    /(?:M\.?\s?W\.?|F\.?\s?W\.?|Mol(?:ecular|\.)?\s*W(?:t\.?|eight)?|Formula\s*weight|M\s*=\s*)\s*[:=]?\s*(\d{1,4}(?:[.,]\d{1,3})?)/i,
    /(\d{1,4}[.,]\d{1,3})\s*g\s*\/\s*mol/i,
  ]).replace(',', '.');
}

export function findFormula(text) {
  // Look for an explicit "Formula:" label; free-floating formula detection is too noisy for OCR text.
  const m = /(?:formula|summenformel)\s*[:=]?\s*([A-Z][A-Za-z0-9·•.()\s]{1,40})/i.exec(text);
  if (!m) return '';
  return m[1].split(/\s{2,}|\n/)[0].replace(/\s+/g, '').replace(/[•]/g, '·');
}

export function findSupplier(text) {
  for (const [name, re] of SUPPLIERS) if (re.test(text)) return name;
  return '';
}

export function findExpiry(text) {
  return firstMatch(text, [
    /(?:exp(?:iry|iration)?\.?\s*(?:date)?|use\s*by|retest(?:\s*date)?|best\s*before)\s*[:.]?\s*([0-9]{1,4}[\/.\-][0-9]{1,2}(?:[\/.\-][0-9]{1,4})?|[A-Z]{3}\s*[0-9]{2,4})/i,
  ]);
}

export function findSignalWord(text) {
  if (/\bDANGER\b|\bGEFAHR\b/i.test(text)) return 'Danger';
  if (/\bWARNING\b|\bACHTUNG\b/i.test(text)) return 'Warning';
  return '';
}

function cleanName(s) {
  return s
    .replace(/[|_~`"“”«»{}\[\]<>]/g, ' ')
    .replace(/[®™©]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[^A-Za-z0-9(]+|[^A-Za-z0-9)%,'-]+$/g, '')
    .trim();
}

/**
 * Rank OCR lines as possible chemical names.
 * lines: [{text, height, conf}] (height = pixel height of the line box)
 */
export function nameCandidates(lines) {
  const scored = [];
  for (const line of lines) {
    const t = cleanName(line.text || '');
    if (t.length < 3 || t.length > 70) continue;
    if (BOILERPLATE.test(t)) continue;
    if (SUPPLIERS.some(([, re]) => re.test(t)) && t.split(/\s+/).length <= 3) continue;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    if (letters / t.length < 0.55) continue;
    // Lots of 1-2 char "words" is OCR junk
    const words = t.split(/\s+/);
    const junk = words.filter((w) => w.length <= 2 && !/^(\d|[A-Z][a-z]?|[A-Z]{2}|of|in|and|or|N|O|S)$/.test(w)).length;
    if (junk / words.length > 0.4) continue;
    const vowels = (t.match(/[aeiouy]/gi) || []).length;
    if (vowels / letters < 0.15) continue;
    let score = (line.height || 10) * ((line.conf ?? 70) / 100);
    if (/(ide|ate|ite|ine|ol|one|ene|ane|yne|ium|ic acid|acid|ose|amide|amine|oxide|chloride|sulfate|phosphate|nitrate|hydroxide|carbonate|acetate|ethanol|methanol|benzene|phenyl|methyl|ethyl|propyl|butyl|buffer|salt)\b/i.test(t)) score *= 1.6;
    if (/^\d/.test(t)) score *= 0.85;
    scored.push({ text: t, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  for (const s of scored) if (!out.some((o) => o.toLowerCase() === s.text.toLowerCase())) out.push(s.text);
  return out.slice(0, 6);
}

/** Parse GS1 element strings found in DataMatrix / GS1-128 barcodes on reagent bottles. */
export function parseGS1(raw) {
  if (!raw) return {};
  const s = raw.replace(/^\]d2|^\]C1/, '');
  const out = {};
  const gs = '\x1d';
  let i = 0;
  const fixed = { '01': 14, '17': 6, '11': 6, '15': 6 };
  while (i < s.length) {
    if (s[i] === gs) { i++; continue; }
    const ai = s.slice(i, i + 2);
    if (fixed[ai]) {
      out[ai] = s.slice(i + 2, i + 2 + fixed[ai]);
      i += 2 + fixed[ai];
    } else if (ai === '10' || ai === '21' || ai === '24' || ai === '91' || ai === '240') {
      const end = s.indexOf(gs, i + 2);
      out[ai] = s.slice(i + 2, end === -1 ? undefined : end);
      i = end === -1 ? s.length : end + 1;
    } else break;
  }
  const res = {};
  if (out['01']) res.gtin = out['01'];
  if (out['10']) res.lot = out['10'];
  if (out['17']) res.expiry = `20${out['17'].slice(0, 2)}-${out['17'].slice(2, 4)}${out['17'].slice(4, 6) !== '00' ? '-' + out['17'].slice(4, 6) : ''}`;
  if (out['24'] || out['240']) res.catalog = out['24'] || out['240'];
  return res;
}

/** Full parse of OCR output. */
export function parseLabel(text, lines = []) {
  const flat = text.replace(/\r/g, '');
  const cas = findCasNumbers(flat);
  return {
    cas: cas[0] || '',
    casAll: cas,
    nameCandidates: nameCandidates(lines.length ? lines : flat.split('\n').map((t) => ({ text: t, height: 10, conf: 70 }))),
    supplier: findSupplier(flat),
    catalog: findCatalog(flat),
    lot: findLot(flat),
    amount: findAmount(flat),
    purity: findPurity(flat),
    mw: findMW(flat),
    formula: findFormula(flat),
    expiry: findExpiry(flat),
    signal: findSignalWord(flat),
  };
}

export const TEMPS = ['RT', '4 °C', '-20 °C', '-80 °C'];

/** Map printed storage conditions to one of the standard lab storage temperatures. */
export function tempFromText(text) {
  const t = (text || '').replace(/[−–—]/g, '-');
  if (/-\s?(70|80)\s*°|ultra[\s-]*low/i.test(t)) return '-80 °C';
  if (/-\s?(15|20|25)\s*°|freez/i.test(t)) return '-20 °C';
  if (/2\s*-\s*8\s*°|\b[2-8]\s*°\s*C|refrigerat|fridge/i.test(t)) return '4 °C';
  if (/room\s*temp|ambient|\bRT\b|15\s*-\s*(25|30)\s*°|\b(20|25)\s*°\s*C/i.test(t)) return 'RT';
  return '';
}
