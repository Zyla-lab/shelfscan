// Settings persisted in localStorage (per-device).
const KEY = 'chemscan.settings.v1';

const DEFAULTS = {
  engine: 'ocr', // 'ocr' (on-device Tesseract) or 'claude' (Claude Haiku, needs apiKey)
  apiKey: '',
  usage: { calls: 0, inTok: 0, outTok: 0 },
  pubchem: true,
  autoCapture: true,
  sensitivity: 2,
  holdMs: 800,
  beep: true,
  userName: '', // saved with each scan as 'Scanned by'
  location: '',
  temp: '',
  libraryMode: 'cards',
};

let cache = null;

export const settings = {
  get() {
    if (!cache) {
      try {
        cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
      } catch {
        cache = { ...DEFAULTS };
      }
    }
    return cache;
  },
  set(patch) {
    cache = { ...this.get(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      /* storage unavailable: keep in memory */
    }
    return cache;
  },
};
