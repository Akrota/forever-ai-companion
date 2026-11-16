// macOS: the line channel between this program (the service) and the app's
// native part (macos/App.swift), which started it. It plays the role of the
// tray helper on Windows (see tray.js): menu bar icon, "keep running?"
// question, notices, plus the app window and the file dialogs.
//
// service -> app: our stdout, lines starting with "@@faic " (anything else on
// stdout is ignored by the app). app -> service: our stdin, one command per line.
import fs from 'node:fs';
import readline from 'node:readline';
import { trayTexts } from './tray.js';

export const PREFIX = '@@faic ';

const oneLine = (s) => String(s).replace(/[\r\n\t]+/g, ' ');

// Returns { send, request, ask, balloon, notify, stop } (the same as startTray, plus
// send(line) and request(kind, title) -> path or null for the dialogs).
export function startShellChannel({
  input = process.stdin, output = process.stdout,
  onOpen = () => {}, onQuit = () => {}, onChoice = () => {}, onClosed = () => {}, log = () => {},
} = {}) {
  const pending = new Map(); // dialog id -> resolve
  let nextId = 1;
  let closed = false;
  let stopping = false; // stop() was called: closing is expected

  const send = (line) => {
    if (closed) return;
    const text = `${PREFIX}${line}\n`;
    try {
      // Pipes are asynchronous on macOS: written at once, so nothing is lost
      // when the service exits right after (an error message, a relaunch).
      if (output === process.stdout) fs.writeSync(1, text);
      else output.write(text);
    } catch {
      try { output.write(text); } catch { /* app gone */ }
    }
  };

  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    const [cmd, a, b] = line.trim().split(/\s+/);
    if (cmd === 'open') onOpen();
    else if (cmd === 'quit') onQuit();
    else if (cmd === 'closed') onClosed();
    else if (cmd === 'choice') onChoice(a, b === '1');
    else if (cmd === 'picked') {
      const done = pending.get(a);
      pending.delete(a);
      done?.(b && b !== '-' ? Buffer.from(b, 'base64').toString('utf8') : null);
    }
  });
  // The app quit (or crashed): nothing to talk to anymore.
  rl.on('close', () => {
    closed = true;
    for (const done of pending.values()) done(null);
    pending.clear();
    if (stopping) return;
    log('The app closed its channel.');
    onQuit();
  });
  input.on?.('error', () => {});
  output.on?.('error', () => {});

  send(`texts ${trayTexts()}`);

  return {
    send,
    request(kind, title = '') {
      const id = String(nextId++);
      return new Promise((resolve) => {
        pending.set(id, resolve);
        send(`${kind} ${id} ${Buffer.from(String(title), 'utf8').toString('base64')}`);
      });
    },
    ask: () => send('ask'),
    balloon: (text) => send(`balloon ${oneLine(text)}`),
    notify: (title, text) => send(`notify ${oneLine(title)}\t${oneLine(text)}`),
    stop: () => { stopping = true; closed = true; rl.close(); },
  };
}
