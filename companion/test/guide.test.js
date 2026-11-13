// The WoW Forever guide: dates in the prompt, and updates downloaded from the internet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foreverGuide } from '../src/assets.js';
import {
  GUIDE_FILE, currentGuide, freshnessSection, guideFreshness, parseGuide, startGuideUpdates, validGuide,
} from '../src/guide.js';
import { buildSystem } from '../src/prompt.js';

const builtin = parseGuide(foreverGuide());
const guideText = (fecha, extra = '') => `---\nfecha: ${fecha}\nversionJuego: 1.61.0\nbuild: 71500\n---\n## Guía base de World of Warcraft: Forever\n${extra}${'Datos de Forever. '.repeat(80)}`;

test('the built-in guide has a date and the game build it describes', () => {
  assert.ok(builtin, 'header parsed');
  assert.match(builtin.meta.fecha, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(builtin.meta.build, 70938);
  assert.ok(!builtin.body.startsWith('---'), 'the header is not sent to the AI');
  assert.match(builtin.body, /9 de diciembre de 2026/);
});

test('the AI knows today\'s date, the guide\'s age and when the game is newer', () => {
  const now = new Date(2026, 11, 20); // 20 Dec 2026
  const fresh = guideFreshness(builtin, { now: new Date(2026, 10, 20), client: { build: 70938, version: '1.60.1' } });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.gameNewer, false);

  const system = buildSystem('', 'fizzi', { now, client: { build: 71500, version: '1.61.0' } });
  assert.match(system, /Hoy es 20 de diciembre de 2026/);
  assert.match(system, /La guía base de Forever se revisó el 13 de noviembre de 2026/);
  assert.match(system, /versión 1\.61\.0 \(build 71500\)/);
  assert.match(system, /Blizzard actualizó el juego después de la guía/);
  assert.match(system, /lo más reciente manda/);
  assert.ok(!system.includes('fecha: 2026'), 'no raw header in the prompt');

  // Old guide, same game: still warns.
  const old = freshnessSection(builtin, { now: new Date(2027, 0, 30), client: { build: 70938 } });
  assert.match(old, /la guía tiene \d+ días/);
  // Fresh guide, same game: no warning.
  const ok = freshnessSection(builtin, { now: new Date(2026, 10, 14), client: { build: 70938 } });
  assert.doesNotMatch(ok, /Atención/);
});

test('only a real, newer guide replaces the one the app has', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(currentGuide(dir).source, 'incluida');

  // Rejected: error pages, other files, huge files, older guides.
  assert.equal(validGuide('<html>404</html>'), null);
  assert.equal(validGuide('---\nfecha: hoy\n---\nWorld of Warcraft: Forever'), null);
  assert.equal(validGuide(guideText('2026-12-01', 'x'.repeat(300 * 1024))), null);

  let served = guideText('2026-12-01');
  let calls = 0;
  const fakeFetch = async (url, { headers }) => {
    calls++;
    if (headers['if-none-match'] === '"v2"' && served.includes('2026-12-01')) return new Response(null, { status: 304 });
    return new Response(served, { status: 200, headers: { etag: '"v2"' } });
  };
  let updated = null;
  const u = startGuideUpdates({ url: 'https://example.test/guide.md', dir, fetchImpl: fakeFetch, intervalMs: 1e9, onUpdate: (g) => { updated = g; } });
  t.after(() => u.stop());

  assert.equal(await u.check('manual'), true);
  assert.equal(updated.meta.fecha, '2026-12-01');
  const now = currentGuide(dir);
  assert.equal(now.source, 'descargada');
  assert.equal(now.meta.build, 71500);

  // Unchanged (304) and older guides are ignored.
  assert.equal(await u.check('manual'), false);
  served = guideText('2026-11-01');
  assert.equal(await u.check('manual'), false);
  assert.equal(currentGuide(dir).meta.fecha, '2026-12-01');

  // A broken download keeps the last good guide.
  served = 'Service Unavailable';
  assert.equal(await u.check('manual'), false);
  assert.equal(currentGuide(dir).meta.fecha, '2026-12-01');

  // The game patched: check right away, but at most every 30 minutes.
  const before = calls;
  await u.check('patch');
  await u.check('patch');
  assert.equal(calls, before, 'a manual check just ran, so the patch check waits');

  // A downloaded guide older than the one inside the app is not used.
  fs.writeFileSync(path.join(dir, GUIDE_FILE), guideText('2026-11-01'));
  assert.equal(currentGuide(dir).source, 'incluida');
});

test('without a published address the app uses its own guide and never downloads', async () => {
  const u = startGuideUpdates({ url: null, dir: os.tmpdir(), fetchImpl: () => { throw new Error('no'); } });
  assert.equal(await u.check('manual'), false);
  u.stop();
});
