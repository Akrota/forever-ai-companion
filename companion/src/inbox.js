// Companion -> game: writes answers into the LoadOnDemand slot addons and
// "rings" signal files. See addon/AzerothIA/Live.lua for the other side.
import fs from 'node:fs';

export function luaString(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/[\x00-\x1f\x7f]/g, (c) => '\\' + String(c.charCodeAt(0)).padStart(3, '0'))
    + '"';
}

export function toLua(value, indent = '') {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'string') return luaString(value);
  const next = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '{}';
    return '{\n' + value.map((v) => next + toLua(v, next) + ',').join('\n') + '\n' + indent + '}';
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '{}';
  return '{\n' + entries
    .map(([k, v]) => {
      const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `[${luaString(k)}]`;
      return `${next}${key} = ${toLua(v, next)},`;
    })
    .join('\n') + '\n' + indent + '}';
}

export function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // On Windows a file being read can block rename for a moment: retry once.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    fs.renameSync(tmp, file);
  }
}

// 16-bit mono PCM WAV with `ms` of silence.
export function silentWav(ms = 50, rate = 22050) {
  const samples = Math.round((rate * ms) / 1000);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

export function inboxSource(answers, extra = {}) {
  const inbox = { v: 1, updated: Math.floor(Date.now() / 1000), ...extra, answers };
  return `-- Generado por Forever AI Companion. No editar.\nAzerothIA_Inbox = ${toLua(inbox)}\n`;
}

export function publishInbox(paths, cfg, answers, extra = {}) {
  const src = inboxSource(answers.slice(-cfg.keepAnswers), extra);
  for (let i = 1; i <= cfg.slots; i++) {
    writeAtomic(`${paths.slotDir(i)}/Inbox.lua`, src);
  }
}

export function ringSignal(paths, index) {
  writeAtomic(paths.signal(index), silentWav());
}

export function resetSignals(paths, cfg) {
  for (let i = 1; i <= cfg.signals; i++) writeAtomic(paths.signal(i), Buffer.alloc(0));
}
