// Google Antigravity CLI (`agy`): lets players use their Google account or
// Google AI Pro / Ultra subscription. Finds it on this PC, checks the sign-in,
// helps install it and sign in, and runs it in headless stream-json mode as a
// plain chat model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { macTerminal, shQuote, spawnArgs, visibleConsole } from './claude-code.js';
import { pathDirs, shellQuote } from './codex.js';
import { t } from './i18n.js';

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Base model slugs shown in the app window or mapped with an effort level.
export const ANTIGRAVITY_MODELS = {
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
};

// Base models that publish effort-suffixed slugs (`-low`, `-medium`, `-high`).
const EFFORT_SUFFIX_MODELS = new Set(Object.keys(ANTIGRAVITY_MODELS));

// "gemini-4-hydrogen-low" -> "Gemini 4 Hydrogen", "gemini-pro-orchestrator-neon" -> "Orchestrator (Neon)".
export function prettyAntigravityModel(id) {
  const s = String(id || '').trim();
  if (!s || s === 'default') return null;
  if (s === 'gemini-pro-orchestrator') return 'Orchestrator';
  if (s === 'gemini-pro-orchestrator-g1-pro') return 'Orchestrator (Argon)';
  const orch = /^gemini-pro-orchestrator-([a-z0-9]+)$/i.exec(s);
  if (orch) return `Orchestrator (${orch[1][0].toUpperCase()}${orch[1].slice(1)})`;

  const base = s.replace(/-(?:low|medium|high|xhigh|max)$/i, '');
  if (ANTIGRAVITY_MODELS[base]) return ANTIGRAVITY_MODELS[base];

  const claude = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(base);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;

  const gemini = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)$/i.exec(base);
  if (gemini) return `Gemini ${gemini[1]} ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}`;

  return s;
}

// --- Finding Antigravity CLI ------------------------------------------------

export function antigravityCandidates(configured) {
  const out = [];
  if (configured && path.isAbsolute(configured)) out.push([configured, 'config']);
  const home = os.homedir();
  if (!isWin) {
    out.push([path.join(home, '.local', 'bin', 'agy'), 'native']);
    for (const d of pathDirs()) out.push([path.join(d, 'agy'), 'path']);
    if (isMac) {
      out.push(['/opt/homebrew/bin/agy', 'homebrew'], ['/usr/local/bin/agy', 'path']);
    }
    return out;
  }
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  out.push([path.join(local, 'agy', 'bin', 'agy.exe'), 'native']);
  for (const d of pathDirs()) {
    out.push([path.join(d, 'agy.exe'), 'path']);
    out.push([path.join(d, 'agy.cmd'), 'path']);
  }
  out.push([path.join(home, '.local', 'bin', 'agy.exe'), 'native']);
  out.push([path.join(home, 'scoop', 'shims', 'agy.exe'), 'scoop']);
  return out;
}

export function findAntigravity(configured) {
  const hit = antigravityCandidates(configured).find(([p]) => p && fs.existsSync(p));
  return hit ? { path: hit[0], source: hit[1] } : null;
}

// --- Sign-in status, install and login --------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SKIP_MODEL_LINE = /^(?:fetching|error:|please sign in|usage:|available models)/i;

function parseModelsLines(text) {
  const out = [];
  for (const line of String(text || '').replace(ANSI_RE, '').split(/[\r\n]+/)) {
    const trimmed = line.trim();
    if (!trimmed || SKIP_MODEL_LINE.test(trimmed)) continue;
    const m = /^([a-z0-9][a-z0-9._:/-]+)(?:\t+|\s{2,})(\S.*)$/i.exec(trimmed)
      || /^([a-z0-9][a-z0-9._:/-]*[-/:.][a-z0-9._:/-]+)\s+(\S.*)$/i.exec(trimmed);
    if (m) out.push({ id: m[1], label: m[2].trim() });
  }
  return out;
}

function extractModelsFromJson(ev) {
  const list = ev?.command?.data?.models || ev?.models;
  if (Array.isArray(list)) {
    const items = list
      .filter((m) => m && typeof m.id === 'string' && m.id.trim())
      .map((m) => ({ id: m.id.trim(), label: String(m.label || m.name || m.id).trim() }));
    if (items.length) return items;
  }
  if (typeof ev?.response === 'string' && ev.response.trim()) {
    return parseModelsLines(ev.response);
  }
  return [];
}

// Parses `agy --output-format json models` or plain `agy models` output into [{ id, label }].
export function parseAntigravityModels(text) {
  const cleaned = String(text || '').replace(ANSI_RE, '').trim();
  if (!cleaned) return [];
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try {
      const parsed = JSON.parse(cleaned);
      return extractModelsFromJson(Array.isArray(parsed) ? { models: parsed } : parsed);
    } catch { /* fall through to line-by-line JSON / text */ }
  }
  const fromJsonLines = [];
  for (const line of cleaned.split(/[\r\n]+/)) {
    const tline = line.trim();
    if (!tline.startsWith('{')) continue;
    try {
      fromJsonLines.push(...extractModelsFromJson(JSON.parse(tline)));
    } catch { /* ignore */ }
  }
  if (fromJsonLines.length) return fromJsonLines;
  return parseModelsLines(cleaned);
}

export function parseAntigravityAuthStatus(code, stdout, stderr) {
  const parsed = parseAntigravityModels(stdout);
  const models = parsed.length ? parsed : parseAntigravityModels(stderr);
  if (code === 0 && models.length > 0) return { loggedIn: true, models };
  const text = `${stdout || ''}\n${stderr || ''}`;
  if (/please sign in|authentication required|not (?:signed|logged) in|unauthori[sz]ed/i.test(text)) {
    return { loggedIn: false, models: [] };
  }
  return { loggedIn: false, models: [], error: t('antigravityStatusFailed') };
}

function execAntigravity(bin, args, timeout) {
  return new Promise((resolve) => {
    const { file, shell } = spawnArgs(bin);
    execFile(file, args, {
      shell,
      windowsHide: true,
      timeout,
      encoding: 'utf8',
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

export async function antigravityAuthStatus(bin, timeout = 20000) {
  let res = await execAntigravity(bin, ['--output-format', 'json', 'models'], timeout);
  if (res.code !== 0 && /flags? provided but not defined:.*output-format|unknown flag.*output-format/i.test(`${res.stdout || ''}\n${res.stderr || ''}`)) {
    res = await execAntigravity(bin, ['models'], timeout);
  }
  return parseAntigravityAuthStatus(res.code, res.stdout, res.stderr);
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function killProcessTree(pid) {
  if (!isWin || !pid) return Promise.resolve();
  return new Promise((resolve) => {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve());
  });
}

let activeLogin = null;

export function stopAntigravityLoginWatch() {
  activeLogin?.stop();
}

export function notifyAntigravityLoggedIn() {
  activeLogin?.onLoggedIn();
}

export function openAntigravityInstall() {
  if (isMac) {
    macTerminal(t('consoleInstallAntigravity'), 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
    return;
  }
  visibleConsole(t('consoleInstallAntigravity'),
    `powershell -NoProfile -ExecutionPolicy Bypass -NoExit -Command "irm https://antigravity.google/cli/install.ps1 | iex; Write-Host; Write-Host '${t('consoleDone')}'"`);
}

// Opens a visible terminal running `agy` for first-time OAuth sign-in, and
// closes that terminal once sign-in succeeds (since `agy` otherwise stays in
// its interactive TUI instead of exiting after browser login).
export function openAntigravityLogin(bin, workDir, {
  check = antigravityAuthStatus, pollMs = 2500, graceMs = 1500, maxWaitMs = 10 * 60000, windowsHide = false,
} = {}) {
  if (isMac) {
    const qBin = shQuote(bin);
    const cd = workDir ? `cd ${shQuote(workDir)} && ` : '';
    const script = [
      'PARENT=$$',
      `(i=0; while [ "$i" -lt 300 ] && kill -0 "$PARENT" 2>/dev/null; do sleep 2; i=$((i+1)); if AGY_CLI_DISABLE_AUTO_UPDATE=true ${qBin} --output-format json models >/dev/null 2>&1 || AGY_CLI_DISABLE_AUTO_UPDATE=true ${qBin} models >/dev/null 2>&1; then sleep 1.5; pkill -TERM -P "$PARENT" 2>/dev/null || true; break; fi; done) &`,
      'WATCHER=$!',
      `${cd}${qBin}`,
      'kill "$WATCHER" 2>/dev/null || true',
    ].join('\n');
    macTerminal(t('consoleSignInAntigravity'), script);
    return { ready: Promise.resolve(null), stop() {} };
  }

  stopAntigravityLoginWatch();
  const title = t('consoleSignInAntigravity').replace(/[&|<>^%"]/g, '').trim() || 'Sign in to Google (Antigravity)';
  const cwd = workDir || os.tmpdir();
  const style = windowsHide ? 'Hidden' : 'Normal';
  const ps = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d /s /c "title %FAIC_AGY_TITLE% & call "%FAIC_AGY_BIN%" || (echo. & pause)"' -WorkingDirectory $env:FAIC_AGY_CWD -WindowStyle ${style} -PassThru; $p.Id`;

  const state = {
    pid: null,
    stopped: false,
    closing: false,
    pendingClose: false,
    timer: null,
    stop() {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (activeLogin === state) activeLogin = null;
    },
    closeSoon() {
      if (state.stopped || state.closing) return;
      if (!state.pid) {
        state.pendingClose = true;
        return;
      }
      state.closing = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(async () => {
        state.timer = null;
        if (!state.stopped && isPidAlive(state.pid)) {
          await killProcessTree(state.pid);
        }
        state.stop();
      }, graceMs);
      state.timer.unref?.();
    },
    onLoggedIn() {
      state.closeSoon();
    },
  };
  activeLogin = state;

  const ready = new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, FAIC_AGY_BIN: bin, FAIC_AGY_CWD: cwd, FAIC_AGY_TITLE: title },
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    }, (err, stdout) => {
      const pid = !err ? Number(String(stdout || '').trim()) : 0;
      if (!Number.isInteger(pid) || pid <= 0) {
        state.stop();
        if (!windowsHide) {
          visibleConsole(t('consoleSignInAntigravity'), `cmd /k ""${bin}" && echo. && echo ${t('consoleDone')}"`, { cwd: workDir });
        }
        resolve(null);
        return;
      }
      if (state.stopped) {
        resolve(pid);
        return;
      }
      state.pid = pid;
      if (state.pendingClose) {
        state.closeSoon();
        resolve(pid);
        return;
      }
      const deadline = Date.now() + maxWaitMs;
      const schedule = () => {
        if (state.stopped || state.closing) return;
        state.timer = setTimeout(tick, pollMs);
        state.timer.unref?.();
      };
      const tick = async () => {
        state.timer = null;
        if (state.stopped || state.closing) return;
        if (!isPidAlive(pid) || Date.now() >= deadline) {
          state.stop();
          return;
        }
        try {
          const s = await check(bin);
          if (s?.loggedIn) {
            state.closeSoon();
            return;
          }
        } catch { /* retry next poll */ }
        schedule();
      };
      schedule();
      resolve(pid);
    });
  });

  return { ready, stop: () => state.stop() };
}

// --- Running headless chat turns --------------------------------------------

// Chat-only guardrail: replaces coding-agent assumptions when talking to the player.
export const ANTIGRAVITY_NOTE = `## Tools
Do not run commands or read or write files: nothing on this PC helps answer. Answer directly from the character data, the guide and, if allowed above, a web search.`;

// Maps (model, effort) onto `agy --model` / `agy --effort` flags.
// Bare Gemini 4 / 3.8 Flash names take effort as a suffix; `default` uses --effort;
// explicit variant slugs and Orchestrators stay untouched without --effort.
export function resolveAntigravityModel(model, effort) {
  const m = String(model || '').trim();
  const e = String(effort || '').trim().toLowerCase();
  if (!m || m === 'default') return { model: null, effort: e || null };
  if (EFFORT_SUFFIX_MODELS.has(m)) return { model: e ? `${m}-${e}` : m, effort: null };
  return { model: m, effort: null };
}

// If `default` + `--effort` is rejected (e.g. Orchestrator or a model without `low`),
// returns the next effort string to retry with, `null` to drop `--effort`, or
// `undefined` when the error is unrelated.
export function fallbackAntigravityEffort(errorText, currentEffort) {
  const text = String(errorText || '');
  if (/effort\s+(?:isn't|is not)\s+adjustable/i.test(text)) return null;
  const m = /has no ["'`]?[a-z]+["'`]? effort\s*\(\s*available\s*:\s*([^)]+)\)/i.exec(text);
  if (!m) return undefined;
  const available = m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!available.length) return null;
  if (String(currentEffort || '').toLowerCase() === 'low' && available.includes('medium')) return 'medium';
  if (available.includes('low')) return 'low';
  if (available.includes('medium')) return 'medium';
  return available[0];
}

// Ephemeral `--settings` payload written per call (never saved to the user's settings.json).
export function antigravitySettings({ webSearch = false } = {}) {
  const deny = ['command(*)', 'read_file(*)', 'write_file(*)', 'execute_url(*)', 'mcp(*)'];
  if (!webSearch) deny.push('read_url(*)');
  return {
    agentMode: '',
    toolPermission: 'request-review',
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    disableSlashCommands: true,
    permissions: {
      allow: webSearch ? ['read_url(*)'] : [],
      deny,
    },
  };
}

export function antigravityArgs(c, { settingsFile, webSearch = false, timeoutMs, effortOverride } = {}) {
  const eff = effortOverride !== undefined ? effortOverride : c.effort;
  const resolved = resolveAntigravityModel(c.model, eff);
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--sandbox',
  ];
  if (settingsFile) args.push('--settings', settingsFile);
  if (timeoutMs) args.push('--print-timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`);
  if (resolved.model) args.push('--model', resolved.model);
  if (resolved.effort) args.push('--effort', resolved.effort);
  args.push(...(c.extraArgs || []));
  return args;
}

export function antigravityInput(prompt) {
  return `${JSON.stringify({ event: 'user', message: { content: String(prompt ?? '') } })}\n`;
}

// Parses NDJSON (`stream-json`) or single `--output-format json` output.
export function parseAntigravityEvents(stdout) {
  let resultText = null;
  let deltas = '';
  let error = null;
  let usage = null;
  let model = null;

  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }

    if (ev.event === 'init') {
      if (ev.init?.model) model = ev.init.model;
    } else if (ev.event === 'step_update') {
      const su = ev.step_update;
      if (!su) continue;
      if (su.model) model = su.model;
      if (su.step_type === 'agent_response' && typeof su.text_delta === 'string') deltas += su.text_delta;
      if (su.usage) usage = su.usage;
    } else if (ev.event === 'result') {
      const r = ev.result;
      if (!r) continue;
      if (r.model) model = r.model;
      if (r.usage) usage = r.usage;
      if (r.status && r.status !== 'SUCCESS') {
        error = r.error || (r.finished_reason ? `${r.status} (${r.finished_reason})` : r.status);
      } else if (typeof r.response === 'string' && r.response.length > 0) {
        resultText = r.response;
      }
    } else if (typeof ev.status === 'string' && ('response' in ev || 'error' in ev || 'finished_reason' in ev)) {
      if (ev.model) model = ev.model;
      if (ev.usage) usage = ev.usage;
      if (ev.status !== 'SUCCESS') {
        error = ev.error || (ev.finished_reason ? `${ev.status} (${ev.finished_reason})` : ev.status);
      } else if (typeof ev.response === 'string' && ev.response.length > 0) {
        resultText = ev.response;
      }
    }
  }

  return { text: resultText !== null ? resultText : deltas, error, usage, model };
}

// Gemini reports input_tokens inclusive of cache_read_tokens; Claude reports
// uncached input_tokens separately, so cache_read_tokens can exceed input_tokens.
export function antigravityUsage(u) {
  if (!u) return null;
  const n = (v) => Math.max(0, Math.round(Number(v) || 0));
  const rawInput = n(u.input_tokens);
  const cached = n(u.cache_read_tokens);
  const input = cached > rawInput ? rawInput + cached : rawInput;
  const output = Math.max(n(u.output_tokens), n(u.thinking_tokens));
  return { input, cached, output };
}

export function friendlyAntigravityError(message) {
  const m = String(message || '');
  if (/authentication required|please sign in|not (?:signed|logged) in|401|unauthori[sz]ed|\blogin\b/i.test(m)) {
    return t('antigravitySignedOut');
  }
  if (/usage limit|rate limit|weekly.*limit|429|quota|out of credits|exhausted|spend[- ]?cap/i.test(m)) {
    return t('antigravityLimit');
  }
  if (/invalid model|not recognized as a known model|model.*(?:not (?:supported|available|found|recognized)|does not exist)|access to model|not included in your plan/i.test(m)) {
    return t('antigravityModel');
  }
  return t('antigravityError', { error: m.slice(0, 300) });
}

export { shellQuote };
