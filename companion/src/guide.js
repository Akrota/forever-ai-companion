// The WoW Forever base guide the AI reads before answering.
//
// A copy ships inside the app (knowledge-builtin/wow-forever.md), but Forever
// keeps changing, so the app also downloads the published guide every few
// hours and keeps the newest one on disk. Every guide starts with a small
// header:
//   ---
//   fecha: 2026-11-13          (when it was last reviewed)
//   versionJuego: 1.60.1       (game version it describes)
//   build: 70938               (game build it describes)
//   ---
import fs from 'node:fs';
import path from 'node:path';
import { foreverGuide } from './assets.js';

export const GUIDE_FILE = 'wow-forever.md';
const MAX_BYTES = 200 * 1024;
const MIN_BODY = 1000;
// Older than this, the AI must double-check facts that may have changed.
export const STALE_DAYS = 21;

// { meta: { fecha, versionJuego, build }, body } or null if it isn't a guide.
export function parseGuide(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.fecha || '')) return null;
  meta.build = meta.build ? Number(meta.build) || null : null;
  return { meta, body: m[2].trim() };
}

// Rejects anything that isn't clearly an updated Forever guide: the text goes
// straight to the AI, so a wrong page or an error page must never replace it.
export function validGuide(text) {
  if (Buffer.byteLength(String(text || '')) > MAX_BYTES) return null;
  const g = parseGuide(text);
  if (!g || g.body.length < MIN_BODY || !/World of Warcraft: Forever/.test(g.body)) return null;
  return g;
}

const newer = (a, b) => (!b || a.meta.fecha > b.meta.fecha ? a : b);

// The newest of: the downloaded guide, the one inside this app.
export function currentGuide(dir) {
  const builtin = parseGuide(foreverGuide());
  let downloaded = null;
  try {
    downloaded = validGuide(fs.readFileSync(path.join(dir, GUIDE_FILE), 'utf8'));
  } catch { /* none yet */ }
  if (downloaded) downloaded.source = 'descargada';
  if (builtin) builtin.source = 'incluida';
  return downloaded ? newer(downloaded, builtin) : builtin;
}

const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);

// "13 de noviembre de 2026"
export function spanishDate(iso) {
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const [y, mo, d] = iso.split('-').map(Number);
  return `${d} de ${months[mo - 1]} de ${y}`;
}

const localIso = (now) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// How fresh the guide is compared with today and with the player's game.
export function guideFreshness(guide, { now = new Date(), client = null } = {}) {
  const today = localIso(now);
  const age = guide ? daysBetween(guide.meta.fecha, today) : null;
  const gameBuild = Number(client?.build) || null;
  const gameNewer = Boolean(guide?.meta.build && gameBuild && gameBuild > guide.meta.build);
  return { today, age, gameBuild, gameVersion: client?.version || null, gameNewer, stale: age !== null && age > STALE_DAYS };
}

// Prompt section: today's date, the guide's date and whether the game changed since.
export function freshnessSection(guide, opts = {}) {
  const f = guideFreshness(guide, opts);
  const lines = [`## Fecha y versión\nHoy es ${spanishDate(f.today)}. Usa esta fecha para todo lo que dependa del calendario (bandas, eventos, parches): lo que la guía anuncia para una fecha ya pasada, ya ocurrió.`];
  if (guide) {
    const ver = guide.meta.versionJuego ? ` para la versión ${guide.meta.versionJuego}${guide.meta.build ? ` (build ${guide.meta.build})` : ''} del juego` : '';
    lines.push(`La guía base de Forever se revisó el ${spanishDate(guide.meta.fecha)}${ver}.`);
  }
  if (f.gameVersion) lines.push(`El jugador tiene la versión ${f.gameVersion}${f.gameBuild ? ` (build ${f.gameBuild})` : ''}.`);
  if (f.gameNewer || f.stale) {
    const why = f.gameNewer ? 'Blizzard actualizó el juego después de la guía' : `la guía tiene ${f.age} días`;
    lines.push(`Atención: ${why}, así que puede haber cambios que no aparecen en ella. Para datos que cambian con los parches (niveles, botín, recompensas, ajustes de clases, fechas, eventos), lo más reciente manda: si puedes buscar en internet, comprueba antes de afirmar; si no, avisa que pudo haber cambiado.`);
  } else {
    lines.push('Si internet muestra algo más reciente que contradice la guía, lo más reciente manda.');
  }
  return lines.join('\n');
}

// Downloads the published guide now and then. Keeps it only if it is valid and
// newer than what the app already has. Returns { check(reason), stop() }.
export function startGuideUpdates({ url, dir, log = () => {}, intervalMs = 6 * 3600000, fetchImpl = fetch, onUpdate = () => {} }) {
  if (!url) return { check: async () => false, stop() {} };
  const etagFile = path.join(dir, `${GUIDE_FILE}.etag`);
  let busy = null;
  let lastAt = 0;

  async function download() {
    const headers = {};
    try { headers['if-none-match'] = fs.readFileSync(etagFile, 'utf8'); } catch { /* first time */ }
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 304) return false;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const guide = validGuide(text);
    if (!guide) throw new Error('el archivo descargado no es una guía válida');
    const have = currentGuide(dir);
    if (have && guide.meta.fecha <= have.meta.fecha) return false;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${GUIDE_FILE}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(dir, GUIDE_FILE));
    const etag = res.headers.get('etag');
    if (etag) fs.writeFileSync(etagFile, etag);
    log(`Guía de Forever actualizada (${guide.meta.fecha}).`);
    onUpdate(guide);
    return true;
  }

  // reason "patch": the game is newer than the guide; at most every 30 minutes.
  function check(reason = 'timer') {
    if (busy) return busy;
    if (reason === 'patch' && Date.now() - lastAt < 30 * 60000) return Promise.resolve(false);
    lastAt = Date.now();
    busy = download()
      .catch((e) => { log(`No se pudo actualizar la guía de Forever: ${e.message}`); return false; })
      .finally(() => { busy = null; });
    return busy;
  }

  const first = setTimeout(() => check('start'), 5000);
  const timer = setInterval(() => check('timer'), intervalMs);
  timer.unref?.();
  first.unref?.();
  return { check, stop() { clearTimeout(first); clearInterval(timer); } };
}
