// Codex (OpenAI's official CLI): lets players use their ChatGPT Plus / Pro
// plan. Finds it on this PC, checks the sign-in, helps install it and sign
// in, and turns it into a plain chat model (see codexArgs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { spawnArgs, visibleConsole } from './claude-code.js';

const isWin = process.platform === 'win32';

// Models shown in the app window (slug -> name). "default" = the plan's default.
export const CODEX_MODELS = {
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-6-astra': 'GPT-6 Astra',
};

function onPath() {
  try {
    const out = execFileSync(isWin ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      // `where` also lists the extension-less npm shim, which Windows can't run.
      .filter((p) => !isWin || /\.(exe|cmd|bat)$/i.test(p));
  } catch {
    return [];
  }
}

// Returns { path, source } or null. The official installer puts it in
// %LOCALAPPDATA%\Programs\OpenAI\Codex\bin; npm in %APPDATA%\npm. Both are
// checked directly: right after installing, this app's PATH is still the old one.
export function findCodex(configured) {
  const candidates = [];
  if (configured && path.isAbsolute(configured)) candidates.push([configured, 'config']);
  if (isWin) {
    candidates.push([path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), 'native']);
  }
  for (const p of onPath()) candidates.push([p, 'path']);
  if (isWin) candidates.push([path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'), 'npm']);
  else candidates.push([path.join(os.homedir(), '.local', 'bin', 'codex'), 'native']);
  const hit = candidates.find(([p]) => p && fs.existsSync(p));
  return hit ? { path: hit[0], source: hit[1] } : null;
}

// `codex login status`: "Logged in using ChatGPT" / "Not logged in" (exit 1).
export function parseLoginStatus(text) {
  const s = String(text || '');
  if (/not logged in/i.test(s) || !/logged in/i.test(s)) return { loggedIn: false, method: null };
  return { loggedIn: true, method: /chatgpt/i.test(s) ? 'chatgpt' : /api key/i.test(s) ? 'api-key' : 'other' };
}

export function codexAuthStatus(bin) {
  return new Promise((resolve) => {
    const { file, shell } = spawnArgs(bin);
    execFile(file, ['login', 'status'], { shell, windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      if (err && !/logged in/i.test(text)) {
        resolve({ loggedIn: false, method: null, error: 'No se pudo consultar Codex.' });
      } else {
        resolve(parseLoginStatus(text));
      }
    });
  });
}

export function openCodexLogin(bin) {
  visibleConsole('Iniciar sesion en ChatGPT', `cmd /k ""${bin}" login && echo. && echo Listo. Ya puedes cerrar esta ventana y volver a Forever AI Companion."`);
}

// OpenAI's official installer (no Node.js needed).
export function openCodexInstall() {
  visibleConsole('Instalar Codex',
    'powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "irm https://chatgpt.com/codex/install.ps1 | iex; Write-Host; Write-Host \'Listo. Ya puedes cerrar esta ventana y volver a Forever AI Companion.\'"');
}

// Codex features that only matter to a coding agent. Unknown names are an
// error in Codex, so this list is dropped and the call retried if a future
// version removes one (see providers.js).
export const CODEX_DISABLE = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'image_generation', 'browser_use',
  'computer_use', 'view_image', 'skill_search', 'tool_suggest', 'goals', 'multi_agent', 'hooks',
];

// TOML literal string ('...'): no escapes, so Windows paths work as they are.
const tomlLiteral = (s) => `'${String(s).replace(/\\/g, '/').replace(/'/g, '')}'`;

// Arguments for `codex exec` so it behaves as a plain chat model, not as a
// coding agent: our own instructions instead of Codex's (~22k characters),
// read-only, no user config/rules/AGENTS.md/skills, nothing saved to disk.
// The question goes in on stdin ("-").
export function codexArgs(c, { instructionsFile, outFile, workDir, webSearch = false, disable = CODEX_DISABLE }) {
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--cd', workDir, '--output-last-message', outFile,
    '-c', `model_instructions_file=${tomlLiteral(instructionsFile)}`,
    '-c', `web_search=${webSearch ? "'live'" : "'disabled'"}`,
    '-c', 'project_doc_max_bytes=0',
    '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false',
    '-c', "personality='none'",
  ];
  if (c.effort) args.push('-c', `model_reasoning_effort=${tomlLiteral(c.effort)}`);
  if (c.model && c.model !== 'default') args.push('--model', c.model);
  for (const f of disable) args.push('--disable', f);
  args.push(...(c.extraArgs || []), '-');
  return args;
}

// cmd.exe (for codex.cmd) splits on spaces: quote what needs it.
export function shellQuote(args) {
  return args.map((a) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a));
}

// Reads the --json event stream: the answer and, if the turn failed, why.
export function parseCodexEvents(stdout) {
  let text = '';
  let error = null;
  let usage = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text = ev.item.text;
    else if (ev.type === 'turn.failed') error = ev.error?.message || 'error';
    else if (ev.type === 'turn.completed') usage = ev.usage || null;
    else if (ev.type === 'error' && !/^Reconnecting/i.test(ev.message || '')) error = error || ev.message;
  }
  return { text, error, usage };
}

// Turns Codex's English errors into something a player can act on.
export function friendlyCodexError(message) {
  const m = String(message || '');
  if (/401|unauthori[sz]ed|not logged in|login/i.test(m)) {
    return 'Codex no tiene la sesión iniciada. Pulsa "Iniciar sesión" en la ventana de Forever AI Companion.';
  }
  if (/usage limit|rate limit|429|quota/i.test(m)) {
    return 'Llegaste al límite de uso de tu plan de ChatGPT. Espera un rato o elige otra IA en la ventana de Forever AI Companion.';
  }
  if (/model.*(not (supported|available|found))|does not exist|access to model/i.test(m)) {
    return 'Tu plan de ChatGPT no incluye ese modelo. Elige "El de tu plan" en la ventana de Forever AI Companion.';
  }
  return `Codex: ${m.slice(0, 300)}`;
}
