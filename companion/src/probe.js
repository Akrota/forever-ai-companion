// Channel probe (/ia probar-canales): watches the files the WoW client might
// write when an addon asks it to, and builds a report of which "invisible"
// channels work on this PC and how fast.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { env } from './config.js';

// AZIA / AzerothIA: what an addon from before the rename writes (it may still
// be loaded in a game that was running when the app updated).
const MARKER = /(?:FAIC|AZIA)-PROBE-(\d+)/g;
const SLOT_DISABLED = /(?:ForeverAICompanion|AzerothIA)_S50\s*:\s*disabled/i;

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Files the client could write: Config.wtf, chat log, macro caches, addon lists.
export function candidateFiles(wowDir) {
  const files = [
    { kind: 'cvar', file: path.join(wowDir, 'WTF', 'Config.wtf') },
    { kind: 'chat', file: path.join(wowDir, 'Logs', 'WoWChatLog.txt') },
  ];
  const accounts = path.join(wowDir, 'WTF', 'Account');
  for (const acc of listDir(accounts).filter((d) => d.isDirectory())) {
    const accDir = path.join(accounts, acc.name);
    files.push({ kind: 'macro', file: path.join(accDir, 'macros-cache.txt') });
    files.push({ kind: 'cvar', file: path.join(accDir, 'config-cache.wtf') });
    for (const realm of listDir(accDir).filter((d) => d.isDirectory() && d.name !== 'SavedVariables')) {
      for (const ch of listDir(path.join(accDir, realm.name)).filter((d) => d.isDirectory())) {
        const chDir = path.join(accDir, realm.name, ch.name);
        files.push({ kind: 'macro', file: path.join(chDir, 'macros-cache.txt') });
        files.push({ kind: 'addons', file: path.join(chDir, 'AddOns.txt') });
        files.push({ kind: 'cvar', file: path.join(chDir, 'config-cache.wtf') });
      }
    }
  }
  return files;
}

// Watches candidate files and records when a probe marker shows up in them.
export function startProbeMonitor({ wowDir, log = () => {}, intervalMs = 500 }) {
  const events = [];
  const mtimes = new Map();
  let files = [];
  let lastList = 0;
  let first = true;

  const scan = () => {
    const now = Date.now();
    if (now - lastList > 5000) { files = candidateFiles(wowDir); lastList = now; }
    for (const { kind, file } of files) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const prev = mtimes.get(file);
      mtimes.set(file, st.mtimeMs);
      if (first || prev === st.mtimeMs) continue;
      let text;
      try {
        // Only the tail of big logs matters.
        const fd = fs.openSync(file, 'r');
        const size = st.size;
        const len = Math.min(size, 2_000_000);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        text = buf.toString('latin1');
      } catch { continue; }
      const tokens = [...text.matchAll(MARKER)].map((m) => m[1]);
      const slotDisabled = kind === 'addons' && SLOT_DISABLED.test(text);
      if (tokens.length || slotDisabled) {
        const ev = { kind, file, time: now, tokens: [...new Set(tokens)], slotDisabled };
        events.push(ev);
        log(`Channel test: marked change in ${path.basename(file)} (${kind})`);
      }
    }
    first = false;
    while (events.length > 200) events.shift();
  };

  scan();
  const timer = setInterval(scan, intervalMs);
  return { events, scan, stop: () => clearInterval(timer) };
}

// Voices Windows offers: classic SAPI (third parties can add voices) and
// OneCore (Narrator voices, closed). Tells which family the game uses.
export function windowsVoices() {
  if (process.platform !== 'win32') return Promise.resolve({ sapi: [], onecore: [] });
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sapi = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$one = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens' | ForEach-Object { (Get-ItemProperty $_.PSPath).'(default)' })
[pscustomobject]@{ sapi = $sapi; onecore = $one } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout) => {
        try {
          const j = JSON.parse(stdout);
          resolve({ sapi: [].concat(j.sapi || []), onecore: [].concat(j.onecore || []) });
        } catch {
          resolve({ sapi: [], onecore: [], error: err?.message });
        }
      });
  });
}

const NAMES = {
  cvar: 'Custom setting variable (Config.wtf)',
  addons: 'Addon list (AddOns.txt)',
  macro: 'Macro (macros-cache.txt)',
  chat: 'Chat log (WoWChatLog.txt)',
};

// Builds the verdict for a probe request. Returns { text, report }.
export async function probeReport(probe, monitor) {
  monitor.scan();
  const actions = probe.actions || {};
  const channels = {};
  for (const kind of Object.keys(NAMES)) {
    const at = (actions[kind] || 0) * 1000;
    const hit = monitor.events.find((e) => e.kind === kind && e.time >= at - 2000 &&
      (kind === 'addons' ? e.slotDisabled : e.tokens.includes(String(probe.token))));
    channels[kind] = {
      api: probe.results?.[kind] ?? 'not tested',
      works: Boolean(hit),
      seconds: hit ? Math.max(0, (hit.time - at) / 1000) : null,
      file: hit?.file,
    };
  }

  const voices = await windowsVoices();
  const gameVoices = (probe.ttsVoices || []).map((v) => v.name).filter(Boolean);
  // The game appends the language: "Microsoft Sabina Desktop - Spanish (Mexico)".
  const base = (n) => n.replace(/\s+-\s+.*$/, '').trim().toLowerCase();
  const sapi = new Set(voices.sapi.map(base));
  const onecore = new Set(voices.onecore.map(base));
  const inSapi = gameVoices.filter((n) => sapi.has(base(n)));
  const inOneCore = gameVoices.filter((n) => onecore.has(base(n)) && !sapi.has(base(n)));
  const tts = {
    api: probe.results?.tts ?? 'not tested',
    gameVoices,
    windowsSapi: voices.sapi,
    windowsOneCore: voices.onecore,
    family: inSapi.length ? 'sapi' : inOneCore.length ? 'onecore' : 'unknown',
  };

  const report = { at: new Date().toISOString(), token: probe.token, channels, tts, flashClientIcon: probe.flashClientIcon };
  try {
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(path.join(env.dataDir, 'probe-report.json'), JSON.stringify(report, null, 2));
  } catch { /* report is also in the answer and the log */ }

  const lines = ['Invisible channel test results:'];
  for (const [kind, c] of Object.entries(channels)) {
    const verdict = c.works
      ? `YES, written after ${c.seconds.toFixed(1)} s`
      : `NO, not written during the test${c.api !== 'ok' ? ` (the game answered: ${c.api})` : ''}`;
    lines.push(`- ${NAMES[kind]}: ${verdict}`);
  }
  const fam = {
    sapi: 'classic Windows voices (a ForeverAICompanion voice can be added)',
    onecore: 'modern Windows voices (custom voices cannot be added)',
    unknown: 'could not be determined',
  }[tts.family];
  lines.push(`- Text to speech: ${gameVoices.length ? `${gameVoices.length} voices in the game, ${fam}` : 'the game offers no voices'}` +
    `${tts.api !== 'ok' ? ` (speak: ${tts.api})` : ''}`);
  lines.push(`- Icon flashing: ${probe.flashClientIcon ? 'available' : 'not available'}`);
  lines.push('If something says NO, the game may only save it when you log out: log out and the app will keep recording it.');
  return { text: lines.join('\n'), report };
}
