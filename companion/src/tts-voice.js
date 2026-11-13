// Installs / removes the silent "ForeverAICompanion" Windows voice (see
// tts/AzerothIATts.cs). Until v1.0 it was called "AzerothIA": installing the new
// voice removes that one in the same administrator prompt.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const VOICE_NAME = 'ForeverAICompanion';
export const LEGACY_VOICE_NAME = 'AzerothIA';
const VENDOR = 'Forever AI Companion';
export const ENGINE_CLSID = '{DE6988DD-75DB-43E9-9021-43C884474FEE}';
const TOKEN_KEY = `HKCU\\Software\\Microsoft\\Speech\\Voices\\Tokens\\${VOICE_NAME}`;
const LEGACY_TOKEN_KEY = `HKCU\\Software\\Microsoft\\Speech\\Voices\\Tokens\\${LEGACY_VOICE_NAME}`;
const CLSID_KEY = `HKCU\\Software\\Classes\\CLSID\\${ENGINE_CLSID}`;
const CLSID_KEY_32 = `HKCU\\Software\\Classes\\WOW6432Node\\CLSID\\${ENGINE_CLSID}`;
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)}: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const reg = (...args) => run('reg.exe', [...args, '/f']);

// Compiles the engine with the C# compiler that ships with Windows.
// A process that used the voice (the game) keeps the DLL open, so it is
// compiled next to it and swapped in: an open DLL can still be renamed.
export async function compileEngine(sourceFile, outFile) {
  if (!fs.existsSync(CSC)) throw new Error('No se encontró el compilador de C# de Windows (.NET Framework 4).');
  const target = path.resolve(outFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The output file name becomes the assembly name, which must stay
  // "AzerothIATts": build into a temporary folder under the final name.
  const buildDir = path.join(path.dirname(target), `.build-${Date.now()}`);
  fs.mkdirSync(buildDir, { recursive: true });
  const fresh = path.join(buildDir, path.basename(target));
  // csc mis-reads forward slashes in paths: always pass absolute Windows paths.
  try {
    await run(CSC, ['/nologo', '/target:library', '/optimize+', `/out:${fresh}`, path.resolve(sourceFile)]);
  } catch (e) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    throw e;
  }
  if (fs.existsSync(target)) {
    try {
      fs.rmSync(target);
    } catch {
      fs.renameSync(target, `${target}.old-${Date.now()}`);
    }
  }
  fs.renameSync(fresh, target);
  fs.rmSync(buildDir, { recursive: true, force: true });
  cleanupOldEngines(target);
  return target;
}

// Removes swapped-out copies once nothing has them open.
export function cleanupOldEngines(target) {
  const dir = path.dirname(target);
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (name.startsWith(`${path.basename(target)}.old-`)) {
      try { fs.rmSync(path.join(dir, name)); } catch { /* still in use */ }
    }
  }
}

export async function installVoice(dllPath) {
  const codeBase = 'file:///' + dllPath.replace(/\\/g, '/');
  for (const key of [CLSID_KEY, CLSID_KEY_32]) {
    await reg('add', key, '/ve', '/d', 'AzerothIA.Tts.Engine');
    const inproc = `${key}\\InprocServer32`;
    await reg('add', inproc, '/ve', '/d', 'mscoree.dll');
    await reg('add', inproc, '/v', 'ThreadingModel', '/d', 'Both');
    await reg('add', inproc, '/v', 'Class', '/d', 'AzerothIA.Tts.Engine');
    await reg('add', inproc, '/v', 'Assembly', '/d', 'AzerothIATts, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null');
    await reg('add', inproc, '/v', 'RuntimeVersion', '/d', 'v4.0.30319');
    await reg('add', inproc, '/v', 'CodeBase', '/d', codeBase);
  }
  await reg('add', TOKEN_KEY, '/ve', '/d', VOICE_NAME);
  await reg('add', TOKEN_KEY, '/v', '409', '/d', VOICE_NAME);
  await reg('add', TOKEN_KEY, '/v', 'CLSID', '/d', ENGINE_CLSID);
  const attrs = `${TOKEN_KEY}\\Attributes`;
  await reg('add', attrs, '/v', 'Name', '/d', VOICE_NAME);
  await reg('add', attrs, '/v', 'Gender', '/d', 'Female');
  await reg('add', attrs, '/v', 'Age', '/d', 'Adult');
  await reg('add', attrs, '/v', 'Language', '/d', '409');
  await reg('add', attrs, '/v', 'Vendor', '/d', VENDOR);
  try { await reg('delete', LEGACY_TOKEN_KEY); } catch { /* not there */ }
}

export async function uninstallVoice() {
  for (const key of [TOKEN_KEY, LEGACY_TOKEN_KEY, CLSID_KEY, CLSID_KEY_32]) {
    try { await reg('delete', key); } catch { /* not installed */ }
  }
}

// --- Machine-wide registration (what the game actually lists) --------------
// SAPI only enumerates voices under HKLM, so the voice token (and, for
// elevated processes, the COM class) is written there once, with one
// administrator prompt (UAC).
const HKLM_TOKEN = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\${VOICE_NAME}`;
const HKLM_LEGACY_TOKEN = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\${LEGACY_VOICE_NAME}`;
const HKLM_CLSID = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\${ENGINE_CLSID}`;

export function machineRegFile(dllPath) {
  const codeBase = 'file:///' + dllPath.replace(/\\/g, '/');
  return [
    'Windows Registry Editor Version 5.00',
    '',
    `[-${HKLM_LEGACY_TOKEN}]`,
    '',
    `[${HKLM_TOKEN}]`,
    `@="${VOICE_NAME}"`,
    `"409"="${VOICE_NAME}"`,
    `"CLSID"="${ENGINE_CLSID}"`,
    '',
    `[${HKLM_TOKEN}\\Attributes]`,
    `"Name"="${VOICE_NAME}"`,
    '"Gender"="Female"',
    '"Age"="Adult"',
    '"Language"="409"',
    `\"Vendor\"=\"${VENDOR}\"`,
    '',
    `[${HKLM_CLSID}]`,
    '@="AzerothIA.Tts.Engine"',
    '',
    `[${HKLM_CLSID}\\InprocServer32]`,
    '@="mscoree.dll"',
    '"ThreadingModel"="Both"',
    '"Class"="AzerothIA.Tts.Engine"',
    '"Assembly"="AzerothIATts, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null"',
    '"RuntimeVersion"="v4.0.30319"',
    `"CodeBase"="${codeBase}"`,
    '',
  ].join('\r\n');
}

export function machineUnregFile() {
  return ['Windows Registry Editor Version 5.00', '', `[-${HKLM_TOKEN}]`, '', `[-${HKLM_LEGACY_TOKEN}]`, '', `[-${HKLM_CLSID}]`, ''].join('\r\n');
}

// Imports a .reg file as administrator (shows the Windows UAC prompt).
async function importElevated(content, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `azerothia-voice-${Date.now()}.reg`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]));
  const script = `
try {
  $p = Start-Process -FilePath reg.exe -ArgumentList @('import', ('"' + $env:AZIA_REG + '"'), '/reg:64') -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $p.ExitCode
} catch { exit 1223 }`;
  try {
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 300000, env: { ...process.env, AZIA_REG: file } }, (err) => {
          if (!err) return resolve();
          if (err.code === 1223) reject(new Error('Se canceló el permiso de administrador.'));
          else reject(new Error(`No se pudo registrar la voz (código ${err.code}).`));
        });
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function installVoiceMachineWide(dllPath, tmpDir) {
  await installVoice(dllPath); // per-user part (no prompt)
  await importElevated(machineRegFile(dllPath), tmpDir);
}

export async function uninstallVoiceMachineWide(tmpDir) {
  await uninstallVoice();
  if (await isVoiceVisible() || await isLegacyVoiceVisible()) await importElevated(machineUnregFile(), tmpDir);
}

async function hklmKeyExists(key) {
  try {
    await run('reg.exe', ['query', key.replace('HKEY_LOCAL_MACHINE', 'HKLM'), '/reg:64']);
    return true;
  } catch {
    return false;
  }
}

// True when SAPI (and so the game) can list the voice.
export const isVoiceVisible = () => hklmKeyExists(HKLM_TOKEN);
// The voice under its first name ("AzerothIA"): still works, should be renamed.
export const isLegacyVoiceVisible = () => hklmKeyExists(HKLM_LEGACY_TOKEN);

export async function isVoiceInstalled() {
  try {
    await run('reg.exe', ['query', TOKEN_KEY]);
    return true;
  } catch {
    return false;
  }
}
