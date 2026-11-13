// Icon next to the Windows clock: a small helper program (tray/Tray.cs)
// compiled with the C# compiler that ships with Windows, like the silent
// voice. Left click opens the window; right click offers Open / Close; when
// the window is closed it asks whether to keep running in the background.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
export const TRAY_EXE = 'ForeverAICompanionTray.exe';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)}: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

// Compiles the helper when it is missing or its source changed.
export async function ensureTrayExe({ source, dir, icoPath }) {
  const exe = path.join(dir, TRAY_EXE);
  const hash = crypto.createHash('sha256').update(source).update(fs.readFileSync(icoPath)).digest('hex');
  const hashFile = `${exe}.source-sha256`;
  if (fs.existsSync(exe) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === hash) return exe;
  if (!fs.existsSync(CSC)) throw new Error('No se encontró el compilador de C# de Windows (.NET Framework 4).');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'Tray.cs');
  fs.writeFileSync(src, source);
  const fresh = path.join(dir, `.tray-${Date.now()}.exe`);
  try {
    await run(CSC, ['/nologo', '/codepage:65001', '/target:winexe', '/optimize+',
      `/win32icon:${path.resolve(icoPath)}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
      `/out:${fresh}`, path.resolve(src)]);
    // A running helper keeps its exe open: an open file can still be renamed.
    if (fs.existsSync(exe)) {
      try { fs.rmSync(exe); } catch { fs.renameSync(exe, `${exe}.old-${Date.now()}`); }
    }
    fs.renameSync(fresh, exe);
    fs.writeFileSync(hashFile, hash);
  } finally {
    fs.rmSync(fresh, { force: true });
    fs.rmSync(src, { force: true });
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${TRAY_EXE}.old-`)) { try { fs.rmSync(path.join(dir, name)); } catch { /* in use */ } }
  }
  return exe;
}

// Starts the helper. Returns { ask(), balloon(text), stop() } or null.
export function startTray({ exe, icoPath, onOpen = () => {}, onQuit = () => {}, onChoice = () => {}, log = () => {} }) {
  let child;
  try {
    child = spawn(exe, [icoPath], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  } catch (e) {
    log(`Ícono de la bandeja: ${e.message}`);
    return null;
  }
  child.on('error', (e) => log(`Ícono de la bandeja: ${e.message}`));
  child.stdin.on('error', () => {});
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const [cmd, a, b] = line.trim().split(/\s+/);
    if (cmd === 'open') onOpen();
    else if (cmd === 'quit') onQuit();
    else if (cmd === 'choice') onChoice(a, b === '1');
  });
  const send = (line) => { try { child.stdin.write(`${line}\n`); } catch { /* helper gone */ } };
  return {
    ask: () => send('ask'),
    balloon: (text) => send(`balloon ${String(text).replace(/[\r\n]+/g, ' ')}`),
    stop: () => { try { child.stdin.end(); } catch { /* ignore */ } },
  };
}
