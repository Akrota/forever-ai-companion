// Moves installs from before the rename (see config.LEGACY_NAME) to the
// current names without losing anything: the app's data folder (API keys,
// settings, state), the addon's saved variables (chats and settings in the
// game), and the old install folder once nothing needs it.
// Every step is safe to repeat and never overwrites the player's newer data.
import fs from 'node:fs';
import path from 'node:path';
import { ADDON_NAME, LEGACY_NAME } from './config.js';

// --- Addon saved variables -------------------------------------------------
// WoW keeps them per addon name in
//   WTF\Account\<ACCOUNT>\SavedVariables\<Addon>.lua                  (account)
//   WTF\Account\<ACCOUNT>\<Realm>\<Character>\SavedVariables\<Addon>.lua (character)
// Global variables the addon declared in its .toc (SavedVariables and
// SavedVariablesPerCharacter), previous name -> current name.
export const SAVED_VARIABLE_RENAMES = { [`${LEGACY_NAME}_DB`]: `${ADDON_NAME}_DB` };
// First line of a copy made here. The game rewrites the file without it the
// first time the addon saves, and from then on the copy is never touched.
export const SV_COPY_MARK = '-- Copied by Forever AI Companion from the addon\'s previous name; the game rewrites this file.';

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

export function savedVariablesDirs(wowDir) {
  const out = [];
  for (const account of subdirs(path.join(wowDir, 'WTF', 'Account'))) {
    out.push(path.join(account, 'SavedVariables'));
    for (const realm of subdirs(account)) {
      if (path.basename(realm).toLowerCase() === 'savedvariables') continue;
      for (const character of subdirs(realm)) out.push(path.join(character, 'SavedVariables'));
    }
  }
  return out.filter((d) => fs.existsSync(d));
}

// Renames the top-level `Name =` assignments. Works on the raw bytes (latin1
// maps them 1:1) so the player's text is copied exactly.
export function renameSavedVariables(text, renames = SAVED_VARIABLE_RENAMES) {
  // A UTF-8 byte order mark (read as latin1) would hide the first line from
  // the rename, and in the middle of the copy it would break the Lua.
  let out = text.replace(/^(?:\xEF\xBB\xBF|﻿)/, '');
  for (const [from, to] of Object.entries(renames)) {
    out = out.replace(new RegExp(`^${from}(?=\\s*=)`, 'gm'), to);
  }
  return out;
}

function writeFileAtomic(file, content, encoding) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, encoding);
  fs.renameSync(tmp, file);
}

// For every <previous name>.lua without a <current name>.lua next to it, writes
// the current one with the variables renamed. The old file stays as a backup.
// A copy made here is refreshed when the old file is newer (a game started
// before the update saved again when it closed). Returns the files written.
export function migrateSavedVariables(wowDir) {
  const written = [];
  for (const dir of savedVariablesDirs(wowDir)) {
    const from = path.join(dir, `${LEGACY_NAME}.lua`);
    const to = path.join(dir, `${ADDON_NAME}.lua`);
    try {
      if (!fs.existsSync(from)) continue;
      if (fs.existsSync(to)) {
        const current = fs.readFileSync(to, 'latin1');
        if (!current.startsWith(SV_COPY_MARK)) continue; // the game already saved the new addon's data
        if (fs.statSync(from).mtimeMs <= fs.statSync(to).mtimeMs) continue;
      }
      const text = renameSavedVariables(fs.readFileSync(from, 'latin1'));
      writeFileAtomic(to, `${SV_COPY_MARK}\n${text}`, 'latin1');
      written.push(to);
    } catch { /* locked right now: next time */ }
  }
  return written;
}

// --- App data folder -------------------------------------------------------
// Written in the current data folder once everything from the old one is there.
export const DATA_MIGRATED_MARK = '.migrated-from-previous-name';
// Never copied: the old voice's inbox is read where it is (voice-inbox.js),
// copying it would answer the same question twice; the voice source is
// rewritten by the app under its current name.
const SKIP = new Set(['tts-inbox', `${LEGACY_NAME}Tts.cs`]);
// Logs keep their content under the current log name.
const RENAME = { [`${LEGACY_NAME.toLowerCase()}.log`]: 'forever-ai-companion.log.old', [`${LEGACY_NAME.toLowerCase()}.log.old`]: null };

// Copies what is missing in `to` (never overwrites). Returns false if something failed.
function copyMissing(from, to) {
  let ok = true;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const target = Object.hasOwn(RENAME, entry.name) ? RENAME[entry.name] : entry.name;
    if (!target) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, target);
    try {
      if (entry.isDirectory()) ok = copyMissing(src, dst) && ok;
      else if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch {
      ok = false;
    }
  }
  return ok;
}

// Tidies a data folder that was renamed as a whole.
function tidyMoved(dir) {
  for (const [name, target] of Object.entries(RENAME)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      if (target && !fs.existsSync(path.join(dir, target))) fs.renameSync(file, path.join(dir, target));
      else fs.rmSync(file, { force: true });
    } catch { /* ignore */ }
  }
  try { fs.rmSync(path.join(dir, `${LEGACY_NAME}Tts.cs`), { force: true }); } catch { /* ignore */ }
}

// Old folder only: renamed (copied when renaming fails). Both: only missing
// files are copied, once. Returns 'none' | 'moved' | 'copied' | 'merged' | 'partial'.
export function migrateDataDir(oldDir, newDir) {
  if (!fs.existsSync(oldDir) || path.resolve(oldDir).toLowerCase() === path.resolve(newDir).toLowerCase()) return 'none';
  const mark = path.join(newDir, DATA_MIGRATED_MARK);
  if (!fs.existsSync(newDir)) {
    try {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
      tidyMoved(newDir);
      fs.writeFileSync(mark, new Date().toISOString());
      return 'moved';
    } catch {
      // Something has a file open in it: copy instead (the old folder stays).
      const ok = copyMissing(oldDir, newDir);
      if (ok) fs.writeFileSync(mark, new Date().toISOString());
      return ok ? 'copied' : 'partial';
    }
  }
  // After a move, a voice from before the rename may recreate the old folder
  // for its inbox: nothing to bring over then.
  if (fs.existsSync(mark)) return 'none';
  const ok = copyMissing(oldDir, newDir);
  if (ok) fs.writeFileSync(mark, new Date().toISOString());
  return ok ? 'merged' : 'partial';
}

// Removes what the voice from before the rename recreates in the old data
// folder (its inbox and log), and the folder if that leaves it empty. Anything
// else in it is the player's and stays. Only once that voice is not in use.
export function tidyLegacyDataDir(oldDir) {
  if (!fs.existsSync(oldDir)) return true;
  const inbox = path.join(oldDir, 'tts-inbox');
  try { if (fs.readdirSync(inbox).length === 0) fs.rmdirSync(inbox); } catch { /* missing or not empty */ }
  try { fs.rmSync(path.join(oldDir, 'tts-engine.log'), { force: true }); } catch { /* in use */ }
  try { if (fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir); } catch { /* not empty */ }
  return !fs.existsSync(oldDir);
}

// --- Install folder --------------------------------------------------------
// The silent voice's DLL from before the rename, while Windows still has the
// voice registered with it (until the player updates the invisible sending).
export const LEGACY_VOICE_DLL = `${LEGACY_NAME}Tts.dll`;

// Empties and removes the old install folder (best effort: a file in use stays
// and is retried on a later start). keepVoiceDll keeps the old voice working.
export function removeLegacyInstallDir(dir, { keepVoiceDll = false } = {}) {
  if (!fs.existsSync(dir)) return true;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  for (const name of names) {
    if (keepVoiceDll && name.toLowerCase() === LEGACY_VOICE_DLL.toLowerCase()) continue;
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* in use */ }
  }
  try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
  return !fs.existsSync(dir);
}
