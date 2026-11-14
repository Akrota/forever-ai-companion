// Updating from before the rename (config.LEGACY_NAME): nothing the player
// had may be lost, and nothing may silently stop working.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_NAME, envVar, loadConfig, wowPaths } from '../src/config.js';
import {
  bundledAddonVersion, ensureAddon, finishLegacyMigration, hasLegacyAddon, installedAddonVersion, isAddonInstalled,
} from '../src/install.js';
import { publishInbox, ringSignal } from '../src/inbox.js';
import {
  DATA_MIGRATED_MARK, LEGACY_VOICE_DLL, SAVED_VARIABLE_RENAMES, SV_COPY_MARK, migrateDataDir, migrateSavedVariables,
  removeLegacyInstallDir, tidyLegacyDataDir,
} from '../src/migrate.js';
import { addonFiles } from '../src/assets.js';
import { parseFrame } from '../src/grid.js';
import { runLua } from './helpers.js';

const OLD_DB = `${LEGACY_NAME}_DB`;
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file, content, enc) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, enc); };
const ago = (file, seconds) => { const t = new Date(Date.now() - seconds * 1000); fs.utimesSync(file, t, t); };

// What WoW writes for the addon (accents in the player's chats as raw UTF-8 bytes).
const oldSaved = (answer) => `\n${OLD_DB} = {\n\t["chats"] = {\n\t\t{\n\t\t\t["title"] = "Misión ñandú",\n\t\t\t["answer"] = "${answer}",\n\t\t},\n\t},\n\t["${OLD_DB}"] = "a string that only looks like the name",\n\t["button"] = {\n\t\t["shown"] = true,\n\t},\n}\n`;

// Loads a saved-variables file like the game does and reads the new variable.
const readNew = (file) => runLua(`
  assert(load(SV))()
  local db = assert(ForeverAICompanion_DB, "variable not renamed")
  RESULT = db.chats[1].title .. "|" .. db.chats[1].answer .. "|" .. tostring(db.button.shown) .. "|" .. tostring(${OLD_DB})`,
{ SV: fs.readFileSync(file, 'utf8') }, []);

function fakeWtf() {
  const wow = tmp('faic-wtf-');
  const account = path.join(wow, 'WTF', 'Account', 'MYACCOUNT');
  const files = {
    account: path.join(account, 'SavedVariables', `${LEGACY_NAME}.lua`),
    character: path.join(account, 'Forever', 'Thoradin', 'SavedVariables', `${LEGACY_NAME}.lua`),
    // A character whose game already saved the new addon: never touched.
    saved: path.join(account, 'Forever', 'Lyra', 'SavedVariables', `${LEGACY_NAME}.lua`),
  };
  write(files.account, oldSaved('hola'), 'utf8');
  write(files.character, oldSaved('per character'), 'utf8');
  write(files.saved, oldSaved('old'), 'utf8');
  write(path.join(path.dirname(files.saved), 'ForeverAICompanion.lua'), '\nForeverAICompanion_DB = {\n}\n');
  // Other addons' files are left alone.
  write(path.join(account, 'SavedVariables', 'Details.lua'), `\n${OLD_DB} = 1\n`);
  return { wow, files, newFile: (f) => path.join(path.dirname(f), 'ForeverAICompanion.lua') };
}

test('every saved variable the addon declares has its previous name mapped', () => {
  const toc = addonFiles()['ForeverAICompanion.toc'];
  const declared = [...toc.matchAll(/^## SavedVariables(?:PerCharacter)?:\s*(.+)$/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  assert.deepEqual(declared, ['ForeverAICompanion_DB']);
  assert.deepEqual(Object.values(SAVED_VARIABLE_RENAMES).sort(), declared.sort());
  assert.match(toc, /^## AddonCompartmentFunc: ForeverAICompanion_Toggle$/m);
});

test('saved variables written with a UTF-8 byte order mark are migrated too', (t) => {
  const wow = tmp('faic-bom-');
  t.after(() => fs.rmSync(wow, { recursive: true, force: true }));
  const old = path.join(wow, 'WTF', 'Account', 'ACC', 'SavedVariables', `${LEGACY_NAME}.lua`);
  write(old, `﻿${OLD_DB} = {\n\t["chats"] = {\n\t\t{\n\t\t\t["title"] = "Mazmorras ñandú",\n\t\t\t["answer"] = "sí",\n\t\t},\n\t},\n\t["button"] = {\n\t\t["shown"] = true,\n\t},\n}\n`, 'utf8');
  assert.equal(migrateSavedVariables(wow).length, 1);
  const copy = path.join(path.dirname(old), 'ForeverAICompanion.lua');
  assert.ok(!fs.readFileSync(copy, 'utf8').includes('﻿'), 'no byte order mark left in the middle of the file');
  assert.equal(readNew(copy), 'Mazmorras ñandú|sí|true|nil');
});

test('saved chats and settings are copied to the new addon name, account and character level', () => {
  const { wow, files, newFile } = fakeWtf();
  try {
    const written = migrateSavedVariables(wow);
    assert.deepEqual(written.sort(), [newFile(files.account), newFile(files.character)].sort());
    for (const [f, answer] of [[files.account, 'hola'], [files.character, 'per character']]) {
      const text = fs.readFileSync(newFile(f), 'utf8');
      assert.ok(text.startsWith(SV_COPY_MARK));
      assert.match(text, /^ForeverAICompanion_DB = \{/m);
      assert.equal(readNew(newFile(f)), `Misión ñandú|${answer}|true|nil`, 'same data, accents intact, old global gone');
      assert.ok(text.includes(`["${OLD_DB}"] = "a string`), 'only top-level assignments are renamed');
      assert.ok(fs.existsSync(f), 'the old file stays as a backup');
    }
    assert.equal(fs.readFileSync(newFile(files.saved), 'utf8'), '\nForeverAICompanion_DB = {\n}\n', 'never overwrites the game\'s own file');
    assert.equal(fs.readFileSync(path.join(wow, 'WTF', 'Account', 'MYACCOUNT', 'SavedVariables', 'Details.lua'), 'utf8'), `\n${OLD_DB} = 1\n`);

    // Nothing new: nothing written.
    assert.deepEqual(migrateSavedVariables(wow), []);

    // A game started before the update saves the old addon again when it closes: copied again.
    ago(newFile(files.account), 60);
    write(files.account, oldSaved('newer chat'), 'utf8');
    assert.deepEqual(migrateSavedVariables(wow), [newFile(files.account)]);
    assert.equal(readNew(newFile(files.account)), 'Misión ñandú|newer chat|true|nil');

    // Once the game saved the new addon itself, the old file is ignored.
    write(newFile(files.character), '\nForeverAICompanion_DB = {\n["x"] = 1,\n}\n');
    ago(newFile(files.character), 60);
    write(files.character, oldSaved('stale'), 'utf8');
    assert.deepEqual(migrateSavedVariables(wow), []);
    assert.equal(fs.readFileSync(newFile(files.character), 'utf8'), '\nForeverAICompanion_DB = {\n["x"] = 1,\n}\n');
  } finally {
    fs.rmSync(wow, { recursive: true, force: true });
  }
});

test('updating from before the rename installs the new addon; the old one goes once the game is closed', () => {
  const { wow, files, newFile } = fakeWtf();
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: wow, slots: 3, signals: 5, keepAnswers: 30 };
  const old = wowPaths(wow).legacy();
  try {
    // What version 1.5.0 installed.
    write(path.join(old.addonDir, `${LEGACY_NAME}.toc`), '## Interface: 16001\n## Version: 1.7.0\n');
    write(old.signal(1), '');
    for (let i = 1; i <= 3; i++) write(path.join(old.slotDir(i), 'Inbox.lua'), `${LEGACY_NAME}_Inbox = {}\n`);
    assert.equal(installedAddonVersion(wow), null, 'only the old addon: needs installing');
    assert.equal(isAddonInstalled(wow, cfg), false);

    // The game is running (with the old addon loaded): install, copy chats, keep the old folders.
    const logs = [];
    assert.equal(ensureAddon(cfg, { wowDir: wow, wowRunning: true, log: (m) => logs.push(m) }), true);
    assert.ok(isAddonInstalled(wow, cfg));
    assert.equal(installedAddonVersion(wow), bundledAddonVersion());
    assert.equal(installedAddonVersion(wow), '1.8.0');
    const toc = fs.readFileSync(path.join(wowPaths(wow).slotDir(2), 'ForeverAICompanion_S02.toc'), 'utf8');
    assert.match(toc, /## Dependencies: ForeverAICompanion\n## Group: ForeverAICompanion\n/);
    assert.ok(fs.existsSync(newFile(files.account)) && fs.existsSync(newFile(files.character)));
    assert.ok(hasLegacyAddon(wow), 'kept while the game may have it loaded');

    // Meanwhile answers reach both addons, each under its own global name.
    publishInbox(wowPaths(wow), cfg, [{ id: 'q1', ok: true, answer: 'hola' }]);
    ringSignal(wowPaths(wow), 1);
    const read = (file, global) => runLua(`assert(load(S))() RESULT = ${global}.answers[1].answer`, { S: fs.readFileSync(file, 'utf8') }, []);
    assert.equal(read(path.join(wowPaths(wow).slotDir(3), 'Inbox.lua'), 'ForeverAICompanion_Inbox'), 'hola');
    assert.equal(read(path.join(old.slotDir(3), 'Inbox.lua'), `${LEGACY_NAME}_Inbox`), 'hola');
    assert.ok(fs.statSync(wowPaths(wow).signal(1)).size > 44 && fs.statSync(old.signal(1)).size > 44);

    // Game closed: the old addon and its slots are removed; the new one stays.
    assert.equal(finishLegacyMigration(wow, { wowRunning: false }), true);
    assert.ok(!hasLegacyAddon(wow));
    assert.ok(!fs.existsSync(old.addonDir) && !fs.existsSync(old.slotDir(1)));
    assert.ok(isAddonInstalled(wow, cfg));
    assert.ok(fs.existsSync(files.account), 'saved variables backup stays');
    // Answers keep working with only the new addon.
    publishInbox(wowPaths(wow), cfg, [{ id: 'q2', ok: true, answer: 'adiós' }]);
    assert.equal(read(path.join(wowPaths(wow).slotDir(1), 'Inbox.lua'), 'ForeverAICompanion_Inbox'), 'adiós');
  } finally {
    fs.rmSync(wow, { recursive: true, force: true });
  }
});

test('the app data folder moves to the new name without losing or overwriting anything', () => {
  const root = tmp('faic-data-');
  const oldDir = path.join(root, LEGACY_NAME);
  const newDir = path.join(root, 'ForeverAICompanion');
  try {
    // Only the old folder: renamed as a whole.
    write(path.join(oldDir, 'config.json'), '{"keys":{"claude":"sk-test"}}');
    write(path.join(oldDir, 'knowledge', 'notes.md'), 'mine');
    write(path.join(oldDir, `${LEGACY_NAME.toLowerCase()}.log`), 'old log');
    write(path.join(oldDir, `${LEGACY_NAME}Tts.cs`), '// old source');
    assert.equal(migrateDataDir(oldDir, newDir), 'moved');
    assert.ok(!fs.existsSync(oldDir));
    assert.equal(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8'), '{"keys":{"claude":"sk-test"}}');
    assert.equal(fs.readFileSync(path.join(newDir, 'knowledge', 'notes.md'), 'utf8'), 'mine');
    assert.equal(fs.readFileSync(path.join(newDir, 'forever-ai-companion.log.old'), 'utf8'), 'old log');
    assert.deepEqual(fs.readdirSync(newDir).filter((n) => n.toLowerCase().includes(LEGACY_NAME.toLowerCase())), []);
    assert.ok(fs.existsSync(path.join(newDir, DATA_MIGRATED_MARK)));

    // The old voice recreates its folder for its inbox: nothing is copied (no question twice).
    write(path.join(oldDir, 'tts-inbox', '1.txt'), 'FAIC:x:1/1:AAAA');
    write(path.join(oldDir, 'tts-engine.log'), 'engine');
    assert.equal(migrateDataDir(oldDir, newDir), 'none');
    assert.ok(!fs.existsSync(path.join(newDir, 'tts-inbox', '1.txt')));
    // Once that voice is updated, its leftovers go (the inbox only when empty).
    tidyLegacyDataDir(oldDir);
    assert.ok(fs.existsSync(path.join(oldDir, 'tts-inbox', '1.txt')), 'unread message kept');
    fs.rmSync(path.join(oldDir, 'tts-inbox', '1.txt'));
    assert.equal(tidyLegacyDataDir(oldDir), true);
    assert.ok(!fs.existsSync(oldDir));

    // Both folders, not merged yet: only missing files are copied, never overwritten.
    fs.rmSync(path.join(newDir, DATA_MIGRATED_MARK));
    write(path.join(oldDir, 'config.json'), '{"old":true}');
    write(path.join(oldDir, 'state.json'), '{"nextSig":7}');
    write(path.join(oldDir, 'guide', 'g.md'), 'guide');
    write(path.join(oldDir, 'tts-inbox', '2.txt'), 'x');
    assert.equal(migrateDataDir(oldDir, newDir), 'merged');
    assert.equal(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8'), '{"keys":{"claude":"sk-test"}}');
    assert.equal(fs.readFileSync(path.join(newDir, 'state.json'), 'utf8'), '{"nextSig":7}');
    assert.equal(fs.readFileSync(path.join(newDir, 'guide', 'g.md'), 'utf8'), 'guide');
    assert.ok(!fs.existsSync(path.join(newDir, 'tts-inbox', '2.txt')));
    assert.ok(fs.existsSync(path.join(oldDir, 'config.json')), 'copying leaves the old folder');
    assert.equal(migrateDataDir(oldDir, newDir), 'none', 'only once');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the old install folder goes, except the voice DLL while Windows still uses it', () => {
  const dir = path.join(tmp('faic-programs-'), LEGACY_NAME);
  try {
    write(path.join(dir, 'ForeverAICompanion.exe'), 'exe');
    write(path.join(dir, `${LEGACY_NAME}.exe`), 'first exe');
    write(path.join(dir, 'ForeverAICompanionTray.exe'), 'tray');
    write(path.join(dir, LEGACY_VOICE_DLL), 'dll');
    write(path.join(dir, `${LEGACY_VOICE_DLL}.source-sha256`), 'hash');
    assert.equal(removeLegacyInstallDir(dir, { keepVoiceDll: true }), false);
    assert.deepEqual(fs.readdirSync(dir), [LEGACY_VOICE_DLL]);
    assert.equal(removeLegacyInstallDir(dir), true);
    assert.ok(!fs.existsSync(dir));
    assert.equal(removeLegacyInstallDir(dir), true, 'nothing to do');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('frames and settings from before the rename are still accepted', () => {
  const frame = Buffer.from(runLua('RESULT = ns.Voice.Base64(ns.Uplink.Frame(J))', { J: '{"id":"x"}' }, ['Json.lua', 'Uplink.lua', 'Voice.lua']), 'base64');
  assert.equal(frame.toString('latin1', 0, 4), 'FAIC');
  assert.equal(parseFrame(frame).toString(), '{"id":"x"}');
  const old = Buffer.from(frame);
  old.write('AZIA', 0, 'latin1');
  assert.equal(parseFrame(old).toString(), '{"id":"x"}');
  const bad = Buffer.from(frame);
  bad.write('XXXX', 0, 'latin1');
  assert.throws(() => parseFrame(bad));

  const saved = { ...process.env };
  try {
    delete process.env.FAIC_PROVIDER;
    process.env.AZIA_PROVIDER = 'echo-old';
    assert.equal(envVar('PROVIDER'), 'echo-old');
    process.env.FAIC_PROVIDER = 'echo-new';
    assert.equal(envVar('PROVIDER'), 'echo-new');
  } finally {
    for (const k of ['FAIC_PROVIDER', 'AZIA_PROVIDER']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});
