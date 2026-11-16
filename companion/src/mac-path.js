// macOS: apps opened from Finder get a minimal PATH (/usr/bin:/bin:...), so
// programs installed by the player (Claude Code, Codex, and the Node.js that
// npm's Codex launcher needs) would not be found or would not start. The PATH
// of the player's own terminal is read once from their login shell, plus the
// usual install folders.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MARK = '__FAIC_PATH__';

export function defaultMacPath(home = os.homedir()) {
  return [
    path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, 'Library', 'pnpm'),
    path.join(home, '.volta', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
}

// "a:b:a:c" + extra -> unique folders, first seen first.
export function mergePath(...lists) {
  const out = [];
  for (const list of lists) {
    for (const d of (Array.isArray(list) ? list : String(list || '').split(':'))) {
      if (d && !out.includes(d)) out.push(d);
    }
  }
  return out.join(':');
}

function loginShellPath(timeout = 6000) {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TERM: 'dumb' },
    }, (_e, stdout) => {
      const m = new RegExp(`${MARK}(.*?)${MARK}`).exec(String(stdout || ''));
      resolve(m ? m[1] : '');
    });
  });
}

export async function fixMacPath(log = () => {}) {
  if (process.platform !== 'darwin') return;
  const fromShell = await loginShellPath().catch(() => '');
  process.env.PATH = mergePath(process.env.PATH, fromShell, defaultMacPath());
  if (!fromShell) log('Could not read the terminal PATH; using the usual folders.');
}
