// Every source file parses, including the ones no other test imports
// (app/main.js, controller.js) and the window's script: a typo there would
// otherwise only show up when building the exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

test('every JavaScript file parses', () => {
  for (const file of [...jsFiles(path.join(root, 'src')), ...jsFiles(path.join(root, 'bin')), ...jsFiles(path.join(root, 'scripts'))]) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(root, file)}: ${r.stderr}`);
  }
});

test("the app window's script parses", (t) => {
  const html = fs.readFileSync(path.join(root, 'src', 'app', 'ui.html'), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faic-ui-')), 'ui.js');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, script);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
