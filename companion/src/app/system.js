// Windows integration for the packaged app: install location, shortcuts,
// start with Windows, opening the window, folder picker, uninstall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as sea from 'node:sea';
import { APP_ID, LEGACY_NAME, envVar, roamingDir } from '../config.js';
import { err, t } from '../i18n.js';

// Name players see (window, shortcuts, messages, start with Windows).
export const DISPLAY_NAME = 'Forever AI Companion';
export const EXE_NAME = 'ForeverAICompanion.exe';
// Internal id: the data and install folders.
export const APP_NAME = APP_ID;
// The project's previous name: its data and install folders, its first exe,
// shortcut and "start with Windows" entry, moved away from by main.js.
const LEGACY_SHORTCUT = `${LEGACY_NAME}.lnk`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ForeverAICompanion';

export const isPackaged = () => {
  try { return sea.isSea(); } catch { return false; }
};
export const isWindows = process.platform === 'win32';

const programsDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs');
export const appDataDir = () => path.join(roamingDir(), APP_NAME);
export const installDir = () => path.join(programsDir(), APP_NAME);
export const installedExe = () => path.join(installDir(), EXE_NAME);
export const legacyAppDataDir = () => path.join(roamingDir(), LEGACY_NAME);
export const legacyInstallDir = () => path.join(programsDir(), LEGACY_NAME);

export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Runs a PowerShell script. Values go in through environment variables so
// paths with quotes or accents never need escaping.
export function powershell(script, { vars = {}, sta = false, timeout = 120000 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (sta) args.push('-STA');
  args.push('-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`);
  const envVars = { ...process.env };
  for (const [k, v] of Object.entries(vars)) envVars[`FAIC_${k}`] = String(v);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { env: envVars, windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

const SHORTCUT_PS = `
$folder = [Environment]::GetFolderPath($env:FAIC_FOLDER)
$old = Join-Path $folder $env:FAIC_LEGACY
if (Test-Path $old) { Remove-Item $old -Force }
$lnk = Join-Path $folder ($env:FAIC_NAME + '.lnk')
# A brand-new shortcut file (not an edited one) makes Explorer read the icon again.
if (Test-Path $lnk) { Remove-Item $lnk -Force }
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = $env:FAIC_TARGET
$s.WorkingDirectory = Split-Path $env:FAIC_TARGET
$s.IconLocation = $env:FAIC_TARGET + ',0'
$s.Description = $env:FAIC_NAME + ': AI assistant for WoW Forever'
$s.Save()`;

// Windows caches program icons by path: after an update it keeps showing the
// old one. This tells Explorer the files changed and refreshes the cache.
const REFRESH_ICONS_PS = `
Add-Type -Namespace Faic -Name Shell -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern void SHChangeNotify(int e, uint f, string a, System.IntPtr b);'
foreach ($p in ($env:FAIC_PATHS -split '\\|')) { if ($p -and (Test-Path $p)) { [Faic.Shell]::SHChangeNotify(0x00002000, 0x0005, $p, [IntPtr]::Zero) } }
[Faic.Shell]::SHChangeNotify(0x08000000, 0, $null, [IntPtr]::Zero)
$ie = Join-Path $env:SystemRoot 'System32\\ie4uinit.exe'
if (Test-Path $ie) { Start-Process $ie -ArgumentList '-show' -WindowStyle Hidden -Wait }`;

export async function refreshIcons(paths) {
  await powershell(REFRESH_ICONS_PS, { vars: { PATHS: paths.join('|') } });
}

export async function createShortcuts(target) {
  if (envVar('NO_SHORTCUTS')) return; // tests
  for (const folder of ['Programs', 'Desktop']) {
    await powershell(SHORTCUT_PS, { vars: { FOLDER: folder, TARGET: target, NAME: DISPLAY_NAME, LEGACY: LEGACY_SHORTCUT } });
  }
  await refreshIcons([target]).catch(() => {});
}

export async function removeShortcuts() {
  await powershell(`
foreach ($f in 'Programs','Desktop') {
  foreach ($n in @(($env:FAIC_NAME + '.lnk'), $env:FAIC_LEGACY)) {
    $p = Join-Path ([Environment]::GetFolderPath($f)) $n
    if (Test-Path $p) { Remove-Item $p -Force }
  }
}`, { vars: { NAME: DISPLAY_NAME, LEGACY: LEGACY_SHORTCUT } });
}

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }));
  });
}

export async function getAutostart() {
  if (!isWindows || !isPackaged()) return null;
  const { ok } = await reg(['query', RUN_KEY, '/v', RUN_VALUE]);
  if (ok) return true;
  return (await reg(['query', RUN_KEY, '/v', LEGACY_NAME])).ok; // entry from before the rename
}

export async function setAutostart(enabled) {
  if (!isWindows || !isPackaged()) throw err('installedOnly');
  await reg(['delete', RUN_KEY, '/v', LEGACY_NAME, '/f']); // entry from before the rename
  if (enabled) {
    await reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${process.execPath}" --background`, '/f']);
  } else {
    await reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  }
  return getAutostart();
}

function detached(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  child.on('error', () => {});
  child.unref();
}

// Opens the UI in an app-style Edge window (no tabs/address bar) when
// available, otherwise in the default browser.
export function openWindow(url) {
  if (!isWindows) {
    detached(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
    return;
  }
  const edge = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((p) => fs.existsSync(p));
  if (edge) detached(edge, [`--app=${url}`, '--window-size=1000,860']);
  else detached('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
}

export function openFolder(dir) {
  fs.mkdirSync(dir, { recursive: true });
  detached(isWindows ? 'explorer.exe' : 'open', [dir]);
}

export async function pickFolder() {
  if (!isWindows) throw err('typePath');
  const out = await powershell(`
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${t('pickFolder').replace(/'/g, "''")}'
$d.ShowNewFolderButton = $false
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`, { sta: true, timeout: 600000 });
  return out || null;
}

export async function showError(message) {
  if (!isWindows) return;
  try {
    await powershell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show($env:FAIC_MSG, $env:FAIC_NAME, 'OK', 'Error') | Out-Null`, { vars: { MSG: message, NAME: DISPLAY_NAME } });
  } catch { /* nothing else we can do */ }
}

// Deletes the install folder a few seconds after this process exits.
export function scheduleSelfDelete(dir) {
  const cmd = `/d /s /c "ping -n 4 127.0.0.1 >nul & rmdir /s /q "${dir}""`;
  spawn('cmd.exe', [cmd], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

export function relaunch(exe, args = []) {
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
}
