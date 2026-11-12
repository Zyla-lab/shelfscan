// Label reading with Claude Haiku (vision). One request per bottle photo, structured JSON out.
//
// Cost control:
//  * the photo is downscaled to 1568 px on the long side (~1,800 image tokens) and sent as JPEG
//  * low effort: the model thinks little or not at all on a plain transcription task
//  * output is a small fixed JSON object; formula, MW and hazards come from PubChem, not Claude
//  * one call per scan; it is only repeated when you tap "Re-read label"
// At $0.10 / $0.50 per million input / output tokens this is roughly $0.0005 per bottle.

export const MODEL = 'claude-haiku-5-5';
const PRICE_IN = 0.1 / 1e6;
const PRICE_OUT = 0.5 / 1e6;
const MAX_SIDE = 1568;

export const costOf = (u) => (u?.inTok || 0) * PRICE_IN + (u?.outTok || 0) * PRICE_OUT;

const SYSTEM = `You read the label of a chemical container (bottle, jar, vial, tube, box) photographed in a research lab, for an inventory.

Rules:
- Transcribe only what is printed or handwritten on the label. Never fill a field from your own knowledge: if the CAS number, lot, amount or anything else is not visible, return "" for it.
- If several containers are visible, read the one that is largest and most central.
- name: the substance name as written, without supplier, grade, purity, amount or catalog words. For a solution or mixture, the main substance (e.g. "Tris-HCl", "Hydrochloric acid").
- search_name: the English name to look this substance up in PubChem. Usually the same as name; translate it if the label is not in English; drop solution-specific words ("solution", "stock").
- cas: CAS registry number exactly as printed, formatted like 7647-14-5. Check the digits carefully.
- concentration: concentration, pH or solvent of a solution as written (e.g. "1 M, pH 8.0", "37% in water"); "" for a pure substance.
- purity: purity or grade as written (e.g. "≥99.5%", "ACS reagent", "BioUltra").
- amount: net quantity on the container (e.g. "500 g", "2.5 L").
- supplier: manufacturer or brand (e.g. "Sigma-Aldrich", "Thermo Scientific"); for a hand-made label, the person's name or initials if written.
- catalog: product / catalog number. lot: lot or batch number. expiry: expiry or retest date as written.
- storage: storage instructions as written (e.g. "Store at 2-8 °C", "Keep away from light").
- signal_word: GHS signal word printed on the label ("Danger" or "Warning"), else "".
- hazard_codes: H-statement codes printed on the label, comma-separated (e.g. "H225, H319"), else "".
- legible: false when no label can be read (blurred, facing away, no container in view).
- confidence: how sure you are that name and cas are read correctly.`;

const field = { type: 'string' };
const SCHEMA = {
  type: 'object',
  properties: {
    legible: { type: 'boolean' },
    name: field,
    search_name: field,
    cas: field,
    concentration: field,
    purity: field,
    amount: field,
    supplier: field,
    catalog: field,
    lot: field,
    expiry: field,
    storage: field,
    signal_word: field,
    hazard_codes: field,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'legible', 'name', 'search_name', 'cas', 'concentration', 'purity', 'amount', 'supplier',
    'catalog', 'lot', 'expiry', 'storage', 'signal_word', 'hazard_codes', 'confidence',
  ],
  additionalProperties: false,
};

let sdk = null;
let client = null;
let clientKey = '';

/** The SDK is loaded only when Claude is used, so OCR-only users don't download it. */
async function getClient(apiKey) {
  sdk ??= (await import('@anthropic-ai/sdk')).default;
  if (!client || clientKey !== apiKey) {
    // The key is the user's own, typed into this device's settings; requests go straight to
    // api.anthropic.com and nowhere else.
    client = new sdk({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 60_000 });
    clientKey = apiKey;
  }
  return client;
}

function toJpegBase64(canvas) {
  const scale = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

/** Turn SDK errors into one short message for the item's alert line. */
export function describeError(e) {
  if (!sdk || !(e instanceof sdk.APIError)) return String(e?.message || e);
  if (e instanceof sdk.AuthenticationError) return 'Claude API key was rejected. Check it in Settings.';
  if (e instanceof sdk.PermissionDeniedError) return 'This API key is not allowed to use Claude Haiku.';
  if (e instanceof sdk.RateLimitError) return 'Claude rate limit or spend limit reached. Try again later.';
  if (e instanceof sdk.APIConnectionError) return 'Could not reach Claude (network).';
  return `Claude error ${e.status ?? ''}: ${e.message}`;
}

/** Network-type failures where falling back to on-device OCR makes sense. */
export function isConnectionError(e) {
  return !!sdk && e instanceof sdk.APIConnectionError;
}

/** Cheap key check: retrieving model info is not billed. */
export async function testKey(apiKey) {
  const c = await getClient(apiKey);
  const m = await c.models.retrieve(MODEL);
  return m.display_name || m.id;
}

/**
 * Read one label photo.
 * @returns {Promise<{data: object, usage: {inTok:number, outTok:number}}>}
 */
export async function readLabel(canvas, apiKey) {
  const c = await getClient(apiKey);
  const response = await c.messages.create({
    model: MODEL,
    max_tokens: 2048, // room for brief thinking plus the JSON (~250 tokens)
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toJpegBase64(canvas) } },
          { type: 'text', text: 'Read this container label.' },
        ],
      },
    ],
  });
  const usage = { inTok: response.usage.input_tokens, outTok: response.usage.output_tokens };
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to read this image.'), { usage });
  if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('Claude response was cut off.'), { usage });
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw Object.assign(new Error('Claude returned no answer.'), { usage });
  return { data: JSON.parse(text), usage };
}
