// Run with: npm test   (pure functions only; no browser needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLabel, casChecksumOk, findCasNumbers, parseGS1, tempFromText, findPurity } from '../src/parse.js';

test('CAS checksum', () => {
  assert.ok(casChecksumOk('7647-14-5'));
  assert.ok(casChecksumOk('67-68-5'));
  assert.ok(!casChecksumOk('67-68-4'));
});

test('CAS with OCR confusions (O→0, l→1)', () => {
  assert.equal(findCasNumbers('CAS N0. 7647-l4-5')[0], '7647-14-5');
});

test('typical Sigma label', () => {
  const text = `SIGMA-ALDRICH\nSodium chloride\nACS reagent, ≥99.0%\nCAS No. 7647-14-5  Product No. S9888-500G\nLot # SLCD1234   500 g\nNaCl  FW 58.44\nStore at room temperature\nwww.sigmaaldrich.com`;
  const lines = text.split('\n').map((t, i) => ({ text: t, height: i === 1 ? 40 : 14, conf: 85 }));
  const p = parseLabel(text, lines);
  assert.equal(p.cas, '7647-14-5');
  assert.equal(p.supplier, 'Sigma-Aldrich');
  assert.equal(p.catalog, 'S9888-500G');
  assert.equal(p.lot, 'SLCD1234');
  assert.equal(p.amount, '500 g');
  assert.equal(p.mw, '58.44');
  assert.equal(p.nameCandidates[0], 'Sodium chloride');
  assert.equal(p.purity, '≥99.0%, ACS reagent');
});

test('grade words are not duplicated', () => {
  assert.equal(findPurity('Acetone HPLC grade'), 'HPLC grade');
});

test('storage temperature mapping', () => {
  assert.equal(tempFromText('Store at room temperature'), 'RT');
  assert.equal(tempFromText('Store at 2-8°C'), '4 °C');
  assert.equal(tempFromText('Store at −20 °C'), '-20 °C');
  assert.equal(tempFromText('Keep at -80°C'), '-80 °C');
  assert.equal(tempFromText('Keep tightly closed'), '');
});

test('GS1 DataMatrix payload', () => {
  const g = parseGS1('0104061833507114\x1d10MKCR3319\x1d17280531');
  assert.equal(g.lot, 'MKCR3319');
  assert.equal(g.expiry, '2028-05-31');
});
