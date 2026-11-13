import fs from 'node:fs';
import path from 'node:path';
import { env } from './config.js';

const stateFile = () => path.join(env.dataDir, 'state.json');

export function loadState(file = stateFile()) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { nextSig: s.nextSig || 1, answers: s.answers || [], processed: s.processed || [] };
  } catch {
    return { nextSig: 1, answers: [], processed: [] };
  }
}

export function saveState(state, file = stateFile()) {
  state.processed = state.processed.slice(-200);
  state.answers = state.answers.slice(-100);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
