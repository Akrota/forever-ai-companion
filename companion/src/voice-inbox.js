// Receives requests through the silent "AzerothIA" voice: the voice engine
// (tts/AzerothIATts.cs) drops every text the game "speaks" with it as a file
// in %APPDATA%\AzerothIA\tts-inbox. Messages are
//   AZIA:<request id>:<part>/<parts>:<base64 chunk>
// and the joined chunks are a frame (see grid.parseFrame).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrame } from './grid.js';

export const voiceInboxDir = () =>
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AzerothIA', 'tts-inbox');

// The game wraps what it speaks in bookmarks named "Start" and "End"; older
// versions of the voice passed them through, so they may surround the message.
const MESSAGE = /AZIA:([^:\s]+):(\d+)\/(\d+):([A-Za-z0-9+/=\s]*)/;

function decodeParts(parts) {
  try {
    return parseFrame(Buffer.from(parts.join(''), 'base64'));
  } catch (first) {
    // Retry without a trailing "End" bookmark glued to a chunk.
    const cleaned = parts.map((p) => p.replace(/End$/, ''));
    if (cleaned.join('') === parts.join('')) throw first;
    return parseFrame(Buffer.from(cleaned.join(''), 'base64'));
  }
}

// Feeds one spoken text. Returns the frame payload when a request is complete.
export function createAssembler() {
  const pending = new Map(); // id -> { parts: [], total, at }
  return {
    add(text) {
      const m = String(text).trim().match(MESSAGE);
      if (!m) return null;
      const [, id, partStr, totalStr, data] = m;
      const part = Number(partStr);
      const total = Number(totalStr);
      if (!part || !total || part > total || total > 1000) return null;
      let p = pending.get(id);
      if (!p) { p = { parts: [], total, at: Date.now() }; pending.set(id, p); }
      p.parts[part - 1] = data.replace(/\s+/g, '');
      // Forget incomplete requests after a minute.
      for (const [k, v] of pending) if (Date.now() - v.at > 60000) pending.delete(k);
      if (p.parts.filter((x) => x !== undefined).length < p.total) return null;
      pending.delete(id);
      return decodeParts(p.parts);
    },
  };
}

// Polls the inbox folder. onPayload(Buffer) for each complete request.
export function startVoiceInbox({ onPayload, log = () => {}, dir = voiceInboxDir(), intervalMs = 100 }) {
  fs.mkdirSync(dir, { recursive: true });
  const assembler = createAssembler();
  let busy = false;
  const poll = () => {
    if (busy) return;
    busy = true;
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); // someone deleted it
      const names = fs.readdirSync(dir).filter((n) => n.endsWith('.txt')).sort();
      for (const name of names) {
        const file = path.join(dir, name);
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        fs.rmSync(file, { force: true });
        try {
          if (!text.includes('AZIA:')) {
            log(`Texto recibido por la voz (no es una pregunta, ${text.length} caracteres): ${text.slice(0, 60)}`);
          }
          const payload = assembler.add(text);
          if (payload) onPayload(payload);
        } catch (e) {
          log(`Mensaje por voz inválido: ${e.message}`);
        }
      }
    } catch (e) {
      log(`Error leyendo la voz: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(poll, intervalMs);
  poll();
  return { stop: () => clearInterval(timer), poll };
}
