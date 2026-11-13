// Installs the addon into WoW Forever and creates the slot addons and signal
// files. WoW must be fully restarted afterwards: it only discovers files that
// exist when it starts.
import fs from 'node:fs';
import path from 'node:path';
import { wowPaths } from './config.js';
import { addonFiles } from './assets.js';
import { inboxSource, silentWav, writeAtomic } from './inbox.js';
import { saveState, loadState } from './state.js';

export function addonVersion(tocText) {
  return (tocText.match(/^## Version:\s*(.+)$/m) || [])[1]?.trim() || null;
}

export function installedAddonVersion(wowDir) {
  const toc = path.join(wowPaths(wowDir).addonDir, 'AzerothIA.toc');
  return fs.existsSync(toc) ? addonVersion(fs.readFileSync(toc, 'utf8')) : null;
}

export function isAddonInstalled(wowDir, cfg) {
  const p = wowPaths(wowDir);
  return fs.existsSync(path.join(p.addonDir, 'AzerothIA.toc')) &&
    fs.existsSync(path.join(p.slotDir(cfg.slots), 'Inbox.lua')) &&
    fs.existsSync(p.signal(cfg.signals));
}

// Copies only the addon's own files (Lua/toc). Used to update an existing install.
export function writeAddonFiles(wowDir, files = addonFiles()) {
  const p = wowPaths(wowDir);
  fs.mkdirSync(p.addonDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(p.addonDir, name), content);
  }
}

export function install(cfg, { wowDir = cfg.wowDir, files = addonFiles(), log = console.log, resetState = true } = {}) {
  const p = wowPaths(wowDir);
  fs.mkdirSync(p.addons, { recursive: true });
  fs.mkdirSync(p.screenshots, { recursive: true });

  const iface = (files['AzerothIA.toc'].match(/^## Interface:\s*(.+)$/m) || [])[1]?.trim() || '16001';

  writeAddonFiles(wowDir, files);
  fs.mkdirSync(p.sigDir, { recursive: true });
  writeAtomic(p.okSignal, silentWav());
  for (let i = 1; i <= cfg.signals; i++) writeAtomic(p.signal(i), Buffer.alloc(0));

  for (let i = 1; i <= cfg.slots; i++) {
    const dir = p.slotDir(i);
    fs.mkdirSync(dir, { recursive: true });
    const num = String(i).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `${p.slotName(i)}.toc`), [
      `## Interface: ${iface}`,
      `## Title: |cff888888Forever AI Companion · buzón ${num}|r`,
      '## Notes: Archivo interno de Forever AI Companion. No lo desactives.',
      '## LoadOnDemand: 1',
      '## Dependencies: AzerothIA',
      '## Group: AzerothIA',
      '',
      'Inbox.lua',
      '',
    ].join('\n'));
    writeAtomic(path.join(dir, 'Inbox.lua'), inboxSource([]));
  }

  if (resetState) {
    // All signal files are empty again, so numbering restarts.
    const state = loadState();
    state.nextSig = 1;
    saveState(state);
  }

  log(`Addon instalado en: ${p.addonDir}`);
  return p;
}

export function uninstall(cfg, wowDir = cfg.wowDir) {
  const p = wowPaths(wowDir);
  fs.rmSync(p.addonDir, { recursive: true, force: true });
  for (let i = 1; i <= cfg.slots; i++) fs.rmSync(p.slotDir(i), { recursive: true, force: true });
}
