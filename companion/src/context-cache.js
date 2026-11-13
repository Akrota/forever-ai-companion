// The addon only sends the sections of the character data that changed.
// Unchanged ones arrive as `same: { section: hash }` and are filled in here
// from the last full copy we received for that character.
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config.js';

const cacheFile = () => path.join(env.dataDir, 'context-cache.json');

export function loadContextCache(file = cacheFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveContextCache(cache, file = cacheFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache));
}

// Completes req.context in place and stores the new sections.
// Returns the names of sections the addon skipped but we don't have.
export function resolveContext(req, cache) {
  if (!req.charKey) return [];
  const store = (cache[req.charKey] ||= {});
  const ctx = (req.context ||= {});
  const same = req.same || {};
  const missing = [];
  for (const [name, hash] of Object.entries(same)) {
    const hit = store[name];
    if (hit && hit.hash === hash) ctx[name] = hit.value;
    else missing.push(name);
  }
  for (const [name, hash] of Object.entries(req.hashes || {})) {
    if (ctx[name] !== undefined && !(name in same)) store[name] = { hash, value: ctx[name] };
  }
  return missing;
}
