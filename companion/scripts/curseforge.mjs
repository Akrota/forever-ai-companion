// The addon on CurseForge (https://www.curseforge.com/wow/addons/forever-ai-companion).
//
//   node scripts/curseforge.mjs zip [out folder]   builds ForeverAICompanion-<addon version>.zip
//   node scripts/curseforge.mjs upload <zip>        uploads it as a new release file
//
// The zip is made by the app's own installer (src/install.js), so it holds
// what a player's AddOns folder gets: the addon, its signal files (sig/) and
// the 50 inboxes. CurseForge replaces the folders of the previous file when it
// updates players' addons: a zip without the inboxes would remove them.
//
// Uploading uses CurseForge's upload API. Environment:
//   CURSEFORGE_TOKEN       an API token of the project's author (never printed)
//   CURSEFORGE_PROJECT_ID  1809113 by default
//   CURSEFORGE_GAME_VERSION_IDS  optional, comma-separated: the game version ids
//                          to tag; otherwise the WoW Forever version named in the
//                          built-in guide's header (gameVersion) is looked up
//   CHANGELOG_FILE         optional Markdown changelog (the release notes)
//   CURSEFORGE_DRY_RUN=1   resolve and print everything, upload nothing
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULTS, ROOT, env } from '../src/config.js';
import { bundledAddonVersion, install } from '../src/install.js';

const API = 'https://wow.curseforge.com/api';
const PROJECT_ID = process.env.CURSEFORGE_PROJECT_ID || '1809113';

function buildZip(outDir = path.join(ROOT, 'dist')) {
  const version = bundledAddonVersion();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-curseforge-'));
  try {
    const wowDir = path.join(work, 'World of Warcraft', '_forever_');
    fs.mkdirSync(path.join(wowDir, 'Interface', 'AddOns'), { recursive: true });
    env.dataDir = path.join(work, 'data'); // the installer's state goes here, not to the real app
    fs.mkdirSync(env.dataDir, { recursive: true });
    install({ ...DEFAULTS }, { wowDir, log: () => {}, wowRunning: false });
    fs.mkdirSync(outDir, { recursive: true });
    const zip = path.resolve(outDir, `ForeverAICompanion-${version}.zip`);
    fs.rmSync(zip, { force: true });
    execFileSync('zip', ['-q', '-r', '-X', zip, '.', '-x', '*.DS_Store'], { cwd: path.join(wowDir, 'Interface', 'AddOns') });
    const files = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter((l) => l && !l.endsWith('/')).length;
    if (files < 600) throw new Error(`the zip has only ${files} files (expected the addon, sig/ and 50 inboxes)`);
    return { zip, version, files };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// The game's version as the built-in guide states it ("gameVersion: 1.60.1").
function gameVersionName() {
  const guide = fs.readFileSync(path.join(ROOT, 'knowledge-builtin', 'wow-forever.md'), 'utf8');
  const m = /^gameVersion:\s*([\d.]+)\s*$/m.exec(guide);
  if (!m) throw new Error('no gameVersion in knowledge-builtin/wow-forever.md');
  return m[1];
}

async function api(pathname, token, init = {}) {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { 'X-Api-Token': token, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`CurseForge ${pathname}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// The ids of the WoW Forever game version to tag the file with.
async function gameVersionIds(token) {
  if (process.env.CURSEFORGE_GAME_VERSION_IDS) {
    return process.env.CURSEFORGE_GAME_VERSION_IDS.split(',').map((s) => Number(s.trim())).filter(Boolean);
  }
  const name = gameVersionName();
  const [versions, types] = await Promise.all([api('/game/versions', token), api('/game/version-types', token)]);
  let hits = versions.filter((v) => v.name === name);
  if (hits.length > 1) {
    const forever = new Set(types.filter((t) => /forever/i.test(`${t.name} ${t.slug}`)).map((t) => t.id));
    hits = hits.filter((v) => forever.has(v.gameVersionTypeID));
  }
  if (hits.length !== 1) {
    throw new Error(`could not tell which CurseForge game version is WoW Forever ${name} (${hits.length} matches): set CURSEFORGE_GAME_VERSION_IDS`);
  }
  return [hits[0].id];
}

async function upload(zip) {
  const token = process.env.CURSEFORGE_TOKEN;
  if (!token) throw new Error('CURSEFORGE_TOKEN is not set');
  const version = /ForeverAICompanion-([\d.]+)\.zip$/.exec(zip)?.[1] || bundledAddonVersion();
  const changelog = process.env.CHANGELOG_FILE && fs.existsSync(process.env.CHANGELOG_FILE)
    ? fs.readFileSync(process.env.CHANGELOG_FILE, 'utf8').trim()
    : 'Needs the free Forever AI Companion app (Windows or Mac), which installs and updates this addon for you.';
  const metadata = {
    changelog,
    changelogType: 'markdown',
    displayName: `Forever AI Companion ${version}`,
    gameVersions: await gameVersionIds(token),
    releaseType: 'release',
  };
  console.log(`Uploading ${path.basename(zip)} to project ${PROJECT_ID}: "${metadata.displayName}", game versions ${metadata.gameVersions.join(', ')}`);
  if (process.env.CURSEFORGE_DRY_RUN) {
    console.log('Dry run: nothing uploaded.');
    return null;
  }
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  form.append('file', new Blob([fs.readFileSync(zip)], { type: 'application/zip' }), path.basename(zip));
  const res = await api(`/projects/${PROJECT_ID}/upload-file`, token, { method: 'POST', body: form });
  console.log(`Uploaded: file id ${res?.id}. CurseForge processes and reviews it before it goes live.`);
  return res;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'zip') {
  const { zip, version, files } = buildZip(arg);
  console.log(`${zip} (addon ${version}, ${files} files)`);
} else if (cmd === 'upload') {
  if (!arg || !fs.existsSync(arg)) throw new Error('usage: node scripts/curseforge.mjs upload <zip>');
  await upload(path.resolve(arg));
} else {
  console.error('usage: node scripts/curseforge.mjs zip [out folder] | upload <zip>');
  process.exit(2);
}
