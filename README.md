# ShelfScan

Phone web app for cataloguing a chemical library. Put the phone on a stand pointing at an empty spot,
place bottles one at a time. Each one is photographed automatically, the label is read on the phone, the
compound is looked up in PubChem, and the next bottle can go in straight away.

No AI service, no account, no server: label text is read on the phone with Tesseract OCR, and data stays
in the browser until you export it.

## Use it

Open **https://zyla-lab.github.io/shelfscan/** on the phone and use *Add to Home Screen*. Every push to
`main` rebuilds and republishes it (`.github/workflows/deploy.yml`).

## Run it locally

```bash
npm install
npm run dev          # https://<this-computer's-IP>:5173  (printed in the terminal)
```

Open the printed **Network** address on the phone (same Wi-Fi, or Tailscale). The certificate is
self-signed, so accept the warning once (Chrome: *Advanced → Proceed*; Safari: *Show details → visit this
website*). Phones only allow camera access over HTTPS, which is why the dev server uses it.

For a permanent install, `npm run build` and put the `dist/` folder on any static HTTPS host (GitHub Pages,
Netlify, a lab web server). Then use *Add to Home Screen* on the phone.

The OCR engine and English language data (~5 MB) are downloaded from the jsDelivr CDN the first time a
label is read, then cached by the browser.

## Using it

1. **Scan tab.** Tap the 📍 chip to set the location (e.g. "Flammables cabinet A, shelf 2") and storage
   temperature for this batch. Every new scan gets them.
2. Point the camera at an empty spot. Status shows **Ready**.
3. Place a bottle with the label facing the camera and let go. After about 0.8 s of stillness it beeps and
   captures. Swap in the next bottle (or remove it first; both work).
4. Reading happens in the background, so you don't wait. The recent strip fills in names as they resolve.
5. **Library tab.** Search, filter by temperature, switch between cards and a table, and tap an item to
   check or edit it. Items marked **CHECK** were not identified; pick a suggested name, or type the CAS
   number and tap *Re-read label*. **2× in lab** marks duplicate CAS numbers.
6. Export:
   - **CSV**: the spreadsheet (UTF-8, opens in Excel).
   - **Printable sheet**: an HTML table with a thumbnail of every bottle. Open it and print to PDF.
   - **ZIP + photos**: CSV, JSON and full-size photos. This is also the backup format; restore it with
     *Settings → Import backup ZIP*.

Other controls: **AUTO** toggles hands-free capture (otherwise use the shutter button), ⚡ is the
flashlight, **+ Photo** adds pictures from the gallery, and *Reset empty view* re-learns the empty spot if
auto-capture gets confused.

## How it works

| File | Role |
|---|---|
| `src/camera.js` | Camera plus auto-capture. Samples a 48×36 grayscale thumbnail about 8×/s, waits for stillness, then compares the frame with the learned empty background and with the last capture (tolerant of small nudges), so a bottle is captured once and the empty spot never is. |
| `src/ocr.js` | Tesseract.js in a Web Worker, with contrast stretch and auto-rotation. Falls back to sparse-text mode on labels with little text. |
| `src/parse.js` | Pure text rules: CAS (checksum-validated, fixes O/0 and l/1 confusions), supplier, catalog #, lot, amount, purity/grade, MW, expiry, storage temperature, GS1 barcode data, and ranking of name candidates. Unit-tested. |
| `src/pubchem.js` | CAS or name → PubChem: canonical name, formula, MW, IUPAC, SMILES, InChIKey, GHS. Uses the ECHA aggregate and ignores minority hazard statements. |
| `src/pipeline.js` | Background queue: OCR → barcodes (Android Chrome) → PubChem → save. |
| `src/db.js` | IndexedDB, with records and photos in separate stores. |
| `src/export.js` | CSV, printable HTML, and ZIP export/import. |
| `src/main.js` | UI. |

```bash
npm test         # parser unit tests
```

## Limits

- On-device OCR does well on flat, well-lit, printed labels and struggles with curved small print, glare
  and handwriting. Good light (or the flashlight) and filling the frame with the label help most. When the
  CAS number is read, PubChem fills everything else reliably. When it isn't, check the item.
- The PubChem lookup sends only the CAS number or candidate name to pubchem.ncbi.nlm.nih.gov. Turn it off in
  Settings for fully offline use.
- Data lives in this browser on this phone. Export the ZIP regularly as a backup. Clearing site data deletes it.
