// App -> game: "is the app open and ready?", shown in the addon's chat header
// (see Live:CheckApp in the addon). Same trick as the answer signals
// (inbox.js): the game can tell whether a sound file plays, and an empty one
// doesn't. The game only sees files that existed when it started, so the
// installer creates them all (createStatusFiles) and afterwards only their
// content changes.
//   st.wav        always plays: the status files are there for this game session.
//   beat1, beat2  while the app runs it switches every BEAT_MS which one plays.
//                 Both silent: the app is closed. One stuck: it crashed or froze.
//   need-ai, need-login, problem
//                 at most one plays: why the app can't answer yet.
import fs from 'node:fs';
import path from 'node:path';
import { silentWav, writeAtomic } from './inbox.js';

export const BEAT_MS = 3000;
export const REASONS = ['need-ai', 'need-login', 'problem'];
const BEATS = ['beat1', 'beat2'];
const SILENT = Buffer.alloc(0);
const SOUND = silentWav();
// Reason files are only rewritten when they change, and every so often anyway
// (in case something else replaced them, e.g. a reinstall).
const REWRITE_EVERY = 20;

export const statusFile = (paths, name) => path.join(paths.sigDir, `${name}.wav`);

// Creates the status files that are missing. An addon installed or updated
// while the game runs gets them too: the game sees them once restarted.
export function createStatusFiles(paths) {
  fs.mkdirSync(paths.sigDir, { recursive: true });
  const marker = statusFile(paths, 'st');
  if (!fs.existsSync(marker)) writeAtomic(marker, SOUND);
  for (const name of [...BEATS, ...REASONS]) {
    const file = statusFile(paths, name);
    if (!fs.existsSync(file)) writeAtomic(file, SILENT);
  }
}

// Keeps the status files up to date while the app runs.
// paths(): the addon's paths, or null when there is no game folder or addon.
// reason(): null when ready, or one of REASONS.
export function startBeacon({ paths: getPaths, reason: getReason, log = () => {}, intervalMs = BEAT_MS }) {
  let beat = 1;
  let ticks = 0;
  let written = new Map(); // file -> playing, for the reason files
  let lastPaths = null;
  let lastError = null;

  // beats: also switch the beat (the timer); refresh() only updates the reason.
  const tick = (beats = true) => {
    let p;
    try {
      p = getPaths();
      // No game folder, or an addon from before these files existed.
      if (!p || !fs.existsSync(statusFile(p, 'st'))) return;
      if (p.sigDir !== lastPaths?.sigDir || (beats && ++ticks % REWRITE_EVERY === 0)) written = new Map();
      lastPaths = p;
      const reason = getReason();
      for (const r of REASONS) {
        const file = statusFile(p, r);
        const on = r === reason;
        if (written.get(file) !== on) {
          writeAtomic(file, on ? SOUND : SILENT);
          written.set(file, on);
        }
      }
      // The old beat goes silent before the new one plays: for an instant
      // none plays (the addon waits for two silent checks), never both.
      if (beats) {
        const next = beat === 1 ? 2 : 1;
        writeAtomic(statusFile(p, `beat${beat}`), SILENT);
        writeAtomic(statusFile(p, `beat${next}`), SOUND);
        beat = next;
      }
      lastError = null;
    } catch (e) {
      if (e.message !== lastError) log(`Could not update the status files for the game: ${e.message}`);
      lastError = e.message;
      written = new Map();
    }
  };

  // Closed: every file silent, so the addon shows the app as closed.
  const clear = () => {
    if (!lastPaths) return;
    for (const name of [...BEATS, ...REASONS]) {
      try { writeAtomic(statusFile(lastPaths, name), SILENT); } catch { /* folder gone */ }
    }
  };

  tick();
  const timer = setInterval(() => tick(true), intervalMs);
  timer.unref?.();
  process.on('exit', clear);

  return {
    // Something changed (settings, sign-in): tell the game now.
    refresh: () => tick(false),
    stop() {
      clearInterval(timer);
      process.off('exit', clear);
      clear();
    },
  };
}
