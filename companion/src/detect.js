// Finds the WoW Forever folder without asking the user, when possible.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

const FOREVER = '_forever_';

// A WoW "flavor" folder (like _retail_ or _forever_) has Interface/WTF/an exe
// (macOS: the "World of Warcraft.app").
export function looksLikeFlavorDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    const names = fs.readdirSync(dir);
    return names.some((n) => /^(Interface|WTF|Data)$/i.test(n) || /^wow.*\.exe$/i.test(n) || /^World of Warcraft.*\.app$/i.test(n));
  } catch {
    return false;
  }
}

// Accepts the WoW root, the _forever_ folder, or anything inside it
// (e.g. Interface\AddOns) and returns the _forever_ folder, or null.
export function normalizeWowDir(dir) {
  if (!dir) return null;
  let d = path.resolve(dir);
  for (let i = 0; i < 4; i++) {
    if (path.basename(d).toLowerCase() === FOREVER) return d;
    const child = path.join(d, FOREVER);
    if (fs.existsSync(child)) return child;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  // A flavor folder with another name: accept it if it looks right.
  return looksLikeFlavorDir(dir) ? path.resolve(dir) : null;
}

function registryInstallDirs() {
  if (process.platform !== 'win32') return [];
  try {
    const script =
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |" +
      " Where-Object { $_.DisplayName -like '*World of Warcraft*' } | ForEach-Object { $_.InstallLocation }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function battleNetDefaultDir() {
  try {
    const file = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Battle.net', 'Battle.net.config')
      : path.join(process.env.APPDATA || '', 'Battle.net', 'Battle.net.config');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = cfg?.Client?.Install?.DefaultInstallPath;
    return base ? [path.join(base, 'World of Warcraft')] : [];
  } catch {
    return [];
  }
}

function commonDirs() {
  if (process.platform === 'darwin') {
    return ['/Applications/World of Warcraft', path.join(os.homedir(), 'Applications', 'World of Warcraft'),
      path.join(os.homedir(), 'Games', 'World of Warcraft')];
  }
  const out = [];
  for (let c = 67; c <= 90; c++) { // C..Z
    const drive = `${String.fromCharCode(c)}:\\`;
    if (!fs.existsSync(drive)) continue;
    for (const base of ['Program Files (x86)', 'Program Files', '', 'Games', 'Juegos', 'Battle.net', 'Blizzard']) {
      out.push(path.join(drive, base, 'World of Warcraft'));
    }
  }
  out.push(path.join(os.homedir(), 'Games', 'World of Warcraft'));
  return out;
}

// Returns every WoW Forever folder found, best first.
export function findWowDirs() {
  const roots = [...registryInstallDirs(), ...battleNetDefaultDir(), ...commonDirs()];
  const found = new Set();
  for (const root of roots) {
    const d = normalizeWowDir(root);
    if (d && path.basename(d).toLowerCase() === FOREVER && fs.existsSync(d)) found.add(d);
  }
  return [...found];
}

const WOW_PROCESS = /^"wow[^"]*\.exe"/im;
// macOS: the game's executable inside its app bundle.
export const MAC_WOW_PROCESS = /World of Warcraft[^/\n]*\.app\/Contents\/MacOS\//i;

function isWowRunningMac(unknown) {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    return MAC_WOW_PROCESS.test(out);
  } catch {
    return unknown;
  }
}

// unknown: the answer when tasklist fails.
export function isWowRunning({ unknown = false } = {}) {
  if (process.platform === 'darwin') return isWowRunningMac(unknown);
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return WOW_PROCESS.test(out);
  } catch {
    return unknown;
  }
}

// Same without blocking. When the answer is unknown, says "running" (the safe
// side for callers that must not touch files the game may be using).
export function isWowRunningAsync() {
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
        (err, out) => resolve(err ? true : MAC_WOW_PROCESS.test(out)));
    });
  }
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 },
      (err, out) => resolve(err ? true : WOW_PROCESS.test(out)));
  });
}
