// Windows integration for the packaged app: install location, shortcuts,
// start with Windows, opening the window, folder picker, uninstall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as sea from 'node:sea';

// Name players see (window, shortcuts, messages, start with Windows).
export const DISPLAY_NAME = 'Forever AI Companion';
export const EXE_NAME = 'ForeverAICompanion.exe';
// Internal id from the app's first name (AzerothIA): the data and install
// folders, the in-game addon folder and the silent voice keep it so updates
// keep chats, settings and the invisible send (no new administrator prompt).
export const APP_NAME = 'AzerothIA';
const LEGACY_EXE = 'AzerothIA.exe';
const LEGACY_SHORTCUT = 'AzerothIA.lnk';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ForeverAICompanion';

export const isPackaged = () => {
  try { return sea.isSea(); } catch { return false; }
};
export const isWindows = process.platform === 'win32';

export const appDataDir = () =>
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
export const installDir = () =>
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', APP_NAME);
export const installedExe = () => path.join(installDir(), EXE_NAME);
export const legacyExe = () => path.join(installDir(), LEGACY_EXE);

export const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Runs a PowerShell script. Values go in through environment variables so
// paths with quotes or accents never need escaping.
export function powershell(script, { vars = {}, sta = false, timeout = 120000 } = {}) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (sta) args.push('-STA');
  args.push('-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`);
  const envVars = { ...process.env };
  for (const [k, v] of Object.entries(vars)) envVars[`AZIA_${k}`] = String(v);
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { env: envVars, windowsHide: true, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

const SHORTCUT_PS = `
$folder = [Environment]::GetFolderPath($env:AZIA_FOLDER)
$old = Join-Path $folder $env:AZIA_LEGACY
if (Test-Path $old) { Remove-Item $old -Force }
$lnk = Join-Path $folder ($env:AZIA_NAME + '.lnk')
# A brand-new shortcut file (not an edited one) makes Explorer read the icon again.
if (Test-Path $lnk) { Remove-Item $lnk -Force }
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = $env:AZIA_TARGET
$s.WorkingDirectory = Split-Path $env:AZIA_TARGET
$s.IconLocation = $env:AZIA_TARGET + ',0'
$s.Description = $env:AZIA_NAME + ': asistente con IA para WoW Forever'
$s.Save()`;

// Windows caches program icons by path: after an update it keeps showing the
// old one. This tells Explorer the files changed and refreshes the cache.
const REFRESH_ICONS_PS = `
Add-Type -Namespace Azia -Name Shell -MemberDefinition '[DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern void SHChangeNotify(int e, uint f, string a, System.IntPtr b);'
foreach ($p in ($env:AZIA_PATHS -split '\\|')) { if ($p -and (Test-Path $p)) { [Azia.Shell]::SHChangeNotify(0x00002000, 0x0005, $p, [IntPtr]::Zero) } }
[Azia.Shell]::SHChangeNotify(0x08000000, 0, $null, [IntPtr]::Zero)
$ie = Join-Path $env:SystemRoot 'System32\\ie4uinit.exe'
if (Test-Path $ie) { Start-Process $ie -ArgumentList '-show' -WindowStyle Hidden -Wait }`;

export async function refreshIcons(paths) {
  await powershell(REFRESH_ICONS_PS, { vars: { PATHS: paths.join('|') } });
}

export async function createShortcuts(target) {
  if (process.env.AZIA_NO_SHORTCUTS) return; // tests
  for (const folder of ['Programs', 'Desktop']) {
    await powershell(SHORTCUT_PS, { vars: { FOLDER: folder, TARGET: target, NAME: DISPLAY_NAME, LEGACY: LEGACY_SHORTCUT } });
  }
  await refreshIcons([target]).catch(() => {});
}

export async function removeShortcuts() {
  await powershell(`
foreach ($f in 'Programs','Desktop') {
  foreach ($n in @(($env:AZIA_NAME + '.lnk'), $env:AZIA_LEGACY)) {
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
  return (await reg(['query', RUN_KEY, '/v', APP_NAME])).ok; // first name of the app
}

export async function setAutostart(enabled) {
  if (!isWindows || !isPackaged()) throw new Error('Solo disponible en la versión instalada.');
  await reg(['delete', RUN_KEY, '/v', APP_NAME, '/f']); // entry of the app's first name
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
  if (!isWindows) throw new Error('Escribe la ruta en la configuración.');
  const out = await powershell(`
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Elige la carpeta de World of Warcraft (o la carpeta _forever_ dentro de ella)'
$d.ShowNewFolderButton = $false
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }`, { sta: true, timeout: 600000 });
  return out || null;
}

export async function showError(message) {
  if (!isWindows) return;
  try {
    await powershell(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show($env:AZIA_MSG, $env:AZIA_NAME, 'OK', 'Error') | Out-Null`, { vars: { MSG: message, NAME: DISPLAY_NAME } });
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
