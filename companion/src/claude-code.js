// Finds Claude Code on this PC, checks whether it is signed in, and helps the
// player install it or sign in, so "use my Claude subscription" works without
// knowing what a PATH is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { t } from './i18n.js';

const isWin = process.platform === 'win32';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The Claude desktop app ships its own copy at
// %LOCALAPPDATA%\Claude-Data\<profile>\claude-code\<version>\<hash>\claude.exe
function desktopAppCopies() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
  const found = [];
  try {
    for (const profile of fs.readdirSync(base)) {
      const ccDir = path.join(base, profile, 'claude-code');
      if (!fs.existsSync(ccDir)) continue;
      for (const version of fs.readdirSync(ccDir)) {
        if (!/^\d+(\.\d+)*$/.test(version)) continue;
        for (const hash of fs.readdirSync(path.join(ccDir, version))) {
          const exe = path.join(ccDir, version, hash, 'claude.exe');
          if (fs.existsSync(exe)) found.push({ exe, version });
        }
      }
    }
  } catch { /* not installed */ }
  return found.sort((a, b) => compareVersions(b.version, a.version)).map((f) => f.exe);
}

function onPath() {
  try {
    const out = execFileSync(isWin ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Returns { path, source } or null. "installed" copies are preferred over the
// desktop app's copy, which moves to a new folder on every app update.
export function findClaudeCode(configured) {
  const home = os.homedir();
  const candidates = [];
  if (configured && path.isAbsolute(configured)) candidates.push([configured, 'config']);
  for (const p of onPath()) candidates.push([p, 'path']);
  candidates.push([path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude'), 'native']);
  if (isWin) candidates.push([path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), 'npm']);
  for (const p of desktopAppCopies()) candidates.push([p, 'desktop']);
  const hit = candidates.find(([p]) => p && fs.existsSync(p));
  return hit ? { path: hit[0], source: hit[1] } : null;
}

// .cmd/.bat need a shell on Windows; real executables must not use one
// (paths with spaces would break).
export function spawnArgs(bin) {
  const needsShell = isWin && /\.(cmd|bat)$/i.test(bin);
  return needsShell ? { file: `"${bin}"`, shell: true } : { file: bin, shell: false };
}

export function authStatus(bin) {
  return new Promise((resolve) => {
    const { file, shell } = spawnArgs(bin);
    execFile(file, ['auth', 'status', '--json'], { shell, windowsHide: true, timeout: 20000, encoding: 'utf8' }, (_err, stdout) => {
      try {
        const s = JSON.parse(stdout);
        resolve({ loggedIn: Boolean(s.loggedIn), method: s.authMethod || null });
      } catch {
        resolve({ loggedIn: false, method: null, error: t('claudeStatusFailed') });
      }
    });
  });
}

// Opens a visible console window running `command` so the player sees progress
// (the sign-in also opens the browser).
export function visibleConsole(title, commandLine) {
  if (!isWin) throw new Error('Windows only.');
  const child = spawn('cmd.exe', [`/d /c start "${title}" ${commandLine}`], {
    detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
  });
  child.on('error', () => {});
  child.unref();
}

export function openLogin(bin) {
  visibleConsole(t('consoleSignInClaude'), `cmd /k ""${bin}" auth login --claudeai && echo. && echo ${t('consoleDone')}"`);
}

// Installs the official native build. If the desktop app's copy exists it can
// install itself; otherwise use Anthropic's official installer script.
export function openInstall() {
  const bundled = desktopAppCopies()[0];
  if (bundled) {
    visibleConsole(t('consoleInstallClaude'), `cmd /k ""${bundled}" install && echo. && echo ${t('consoleDone')}"`);
  } else {
    visibleConsole(t('consoleInstallClaude'),
      `powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "irm https://claude.ai/install.ps1 | iex; Write-Host; Write-Host '${t('consoleDone')}'"`);
  }
}
