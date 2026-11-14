// The app window tells the server when it closes; a reload or another open
// window is not a close.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/app/server.js';
import { LEGACY_NAME } from '../src/config.js';

test('closing the window is detected quickly; a reload or another window is not', async () => {
  let closed = 0;
  const server = createServer({ status: async () => ({}) }, { onWindowClosed: () => { closed++; }, closeDelayMs: 150 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const closeWin = (page) => fetch(base + '/api/window-closed', {
    method: 'POST', headers: { 'x-forever-ai-companion': '1', 'content-type': 'application/json' }, body: JSON.stringify({ page }),
  });
  const status = (page) => fetch(`${base}/api/status?page=${page}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Reload: the page closes and the new page (new id) asks right away.
  await status('a');
  await closeWin('a');
  await wait(30);
  await status('b');
  await wait(250);
  assert.equal(closed, 0, 'a reload must not count as closing');

  // Two windows open, one closes: the other keeps the app open.
  await status('c');
  await closeWin('c');
  await wait(250);
  assert.equal(closed, 0, 'another window is still open');

  // The last window closes: detected in about closeDelayMs.
  await closeWin('b');
  await wait(250);
  assert.equal(closed, 1);

  // Without the app's header, other websites cannot trigger it.
  const r = await fetch(base + '/api/window-closed', { method: 'POST' });
  assert.equal(r.status, 403);
  // A window left open from before the rename still sends the previous header.
  const old = await fetch(base + '/api/window-closed', {
    method: 'POST', headers: { [`x-${LEGACY_NAME.toLowerCase()}`]: '1', 'content-type': 'application/json' }, body: JSON.stringify({ page: 'old' }),
  });
  assert.equal(old.status, 200);
  // Other copies of the app recognize this one by its id.
  assert.deepEqual(await (await fetch(base + '/api/ping')).json(), { app: 'ForeverAICompanion' });
  server.close();
});

test('the window icon is served', async () => {
  const server = createServer({ status: async () => ({}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const r = await fetch(`http://127.0.0.1:${server.address().port}/icon.png`);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
  server.close();
});