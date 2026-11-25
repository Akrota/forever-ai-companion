// Antigravity CLI (Google account / Google AI plan) as the AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ANTIGRAVITY_CODE_REDIRECT_URI, ANTIGRAVITY_NOTE, antigravityArgs, antigravityAuthStatus, antigravityInput,
  antigravityLoginState, antigravitySettings, antigravityUsage, cancelAntigravityLogin, fallbackAntigravityEffort,
  findAntigravity, friendlyAntigravityError, friendlyAntigravityLoginError, parseAntigravityAuthStatus,
  parseAntigravityAuthUrl, parseAntigravityEvents, parseAntigravityLoginCode, parseAntigravityModels,
  prettyAntigravityModel, resolveAntigravityModel, startAntigravityLogin, stopAntigravityLogin,
  submitAntigravityLoginCode,
} from '../src/antigravity.js';
import { ROOT, applyPreset, env, loadConfig } from '../src/config.js';
import { runInLang, t } from '../src/i18n.js';
import { ask, canSearch } from '../src/providers.js';
import { createController } from '../src/app/controller.js';
import { createServer } from '../src/app/server.js';

const isWin = process.platform === 'win32';

test('model and effort resolution maps bare models and keeps explicit slugs', () => {
  assert.deepEqual(resolveAntigravityModel('default', 'low'), { model: null, effort: 'low' });
  assert.deepEqual(resolveAntigravityModel('default', ''), { model: null, effort: null });
  assert.deepEqual(resolveAntigravityModel('gemini-4-hydrogen', 'low'), { model: 'gemini-4-hydrogen-low', effort: null });
  assert.deepEqual(resolveAntigravityModel('gemini-4-neon', 'high'), { model: 'gemini-4-neon-high', effort: null });
  assert.deepEqual(resolveAntigravityModel('gemini-4-carbon', 'medium'), { model: 'gemini-4-carbon-medium', effort: null });
  assert.deepEqual(resolveAntigravityModel('gemini-3.8-flash', 'low'), { model: 'gemini-3.8-flash-low', effort: null });
  assert.deepEqual(resolveAntigravityModel('gemini-3.8-flash', 'high'), { model: 'gemini-3.8-flash-high', effort: null });
  assert.deepEqual(resolveAntigravityModel('gemini-4-argon', 'low'), { model: 'gemini-4-argon-low', effort: null });
  // Explicit variants and Orchestrators stay untouched.
  assert.deepEqual(resolveAntigravityModel('gemini-4-hydrogen-xhigh', 'low'), { model: 'gemini-4-hydrogen-xhigh', effort: null });
  assert.deepEqual(resolveAntigravityModel('gemini-pro-orchestrator-neon', 'low'), { model: 'gemini-pro-orchestrator-neon', effort: null });

  assert.equal(fallbackAntigravityEffort("Effort isn't adjustable for Orchestrator (Neon).", 'low'), null);
  assert.equal(fallbackAntigravityEffort('gemini-3.8-flash has no "low" effort (available: medium, high)', 'low'), 'medium');
  assert.equal(fallbackAntigravityEffort('x has no "max" effort (available: low, medium, high)', 'max'), 'low');
  assert.equal(fallbackAntigravityEffort('rate limit exceeded', 'low'), undefined);
});

test('pretty model names format Gemini, Orchestrator and Claude variants', () => {
  assert.equal(prettyAntigravityModel('default'), null);
  assert.equal(prettyAntigravityModel(''), null);
  assert.equal(prettyAntigravityModel('gemini-4-hydrogen-low'), 'Gemini 4 Hydrogen');
  assert.equal(prettyAntigravityModel('gemini-4-neon-xhigh'), 'Gemini 4 Neon');
  assert.equal(prettyAntigravityModel('gemini-3.8-flash-medium'), 'Gemini 3.8 Flash');
  assert.equal(prettyAntigravityModel('gemini-pro-orchestrator'), 'Orchestrator');
  assert.equal(prettyAntigravityModel('gemini-pro-orchestrator-g1-pro'), 'Orchestrator (Argon)');
  assert.equal(prettyAntigravityModel('gemini-pro-orchestrator-neon'), 'Orchestrator (Neon)');
  assert.equal(prettyAntigravityModel('claude-sonnet-5-5'), 'Claude Sonnet 5.5');
});

test('ephemeral settings and CLI args lock down local tools and toggle web reading', () => {
  const withoutWeb = antigravitySettings({ webSearch: false });
  assert.equal(withoutWeb.agentMode, '');
  assert.equal(withoutWeb.toolPermission, 'request-review');
  assert.equal(withoutWeb.allowNonWorkspaceAccess, false);
  assert.equal(withoutWeb.enableTerminalSandbox, true);
  assert.equal(withoutWeb.disableSlashCommands, true);
  assert.deepEqual(withoutWeb.permissions.allow, []);
  for (const rule of ['command(*)', 'read_file(*)', 'write_file(*)', 'execute_url(*)', 'mcp(*)', 'read_url(*)']) {
    assert.ok(withoutWeb.permissions.deny.includes(rule), rule);
  }

  const withWeb = antigravitySettings({ webSearch: true });
  assert.deepEqual(withWeb.permissions.allow, ['read_url(*)']);
  assert.ok(!withWeb.permissions.deny.includes('read_url(*)'));

  const args = antigravityArgs({ model: 'gemini-4-hydrogen', effort: 'low' }, {
    settingsFile: 'C:\\tmp\\agy-settings.json', webSearch: true, timeoutMs: 180000,
  });
  const at = (f) => args[args.indexOf(f) + 1];
  assert.equal(at('--input-format'), 'stream-json');
  assert.equal(at('--output-format'), 'stream-json');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--sandbox'));
  assert.equal(at('--settings'), 'C:\\tmp\\agy-settings.json');
  assert.equal(at('--print-timeout'), '180s');
  assert.equal(at('--model'), 'gemini-4-hydrogen-low');
  assert.ok(!args.includes('--effort'));

  const defArgs = antigravityArgs({ model: 'default', effort: 'low' }, { settingsFile: 's.json' });
  assert.ok(!defArgs.includes('--model'));
  assert.equal(defArgs[defArgs.indexOf('--effort') + 1], 'low');

  const dropped = antigravityArgs({ model: 'default', effort: 'low' }, { settingsFile: 's.json', effortOverride: null });
  assert.ok(!dropped.includes('--effort'));

  const line = antigravityInput('Hola');
  assert.ok(line.endsWith('\n'));
  assert.deepEqual(JSON.parse(line), { event: 'user', message: { content: 'Hola' } });
});

test('events, usage, models and auth status parsing match Antigravity CLI formats', () => {
  const stream = [
    'Warning: minor notice',
    JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'gemini-4-hydrogen-low' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Go to ' } }),
    JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'Deadmines.' } }),
    JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'Go to Deadmines.\n',
        usage: { input_tokens: 10415, output_tokens: 657, thinking_tokens: 616, cache_read_tokens: 8113, total_tokens: 11072 },
      },
    }),
  ].join('\n');
  const parsed = parseAntigravityEvents(stream);
  assert.equal(parsed.text, 'Go to Deadmines.\n');
  assert.equal(parsed.error, null);
  assert.equal(parsed.model, 'gemini-4-hydrogen-low');
  assert.deepEqual(antigravityUsage(parsed.usage), { input: 10415, cached: 8113, output: 657 });

  // Delta fallback if result.response is omitted; Claude-style uncached input_tokens.
  const claudeStyle = parseAntigravityEvents([
    JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'Hi' } }),
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 278, output_tokens: 4, thinking_tokens: 12, cache_read_tokens: 30214 } } }),
  ].join('\n'));
  assert.equal(claudeStyle.text, 'Hi');
  assert.deepEqual(antigravityUsage(claudeStyle.usage), { input: 30492, cached: 30214, output: 12 });
  assert.equal(antigravityUsage(null), null);

  // Error envelope in stream-json and single json.
  const errEv = parseAntigravityEvents(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'Authentication required' } }));
  assert.equal(errEv.error, 'Authentication required');
  const singleErr = parseAntigravityEvents(JSON.stringify({ status: 'ERROR', finished_reason: 'print_timeout' }));
  assert.equal(singleErr.error, 'ERROR (print_timeout)');

  const modelsJson = JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response: 'gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)\n',
    command: {
      name: 'models',
      data: {
        models: [
          { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
          { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
        ],
      },
    },
  });
  assert.deepEqual(parseAntigravityModels(modelsJson), [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
  ]);
  assert.deepEqual(parseAntigravityAuthStatus(0, modelsJson, ''), {
    loggedIn: true,
    models: [
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
      { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
    ],
  });

  // Tab-separated piped output + ANSI escape sequences + space-aligned TTY output + single-space slug.
  const pipedOut = [
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    '\x1b[1mgemini-4-hydrogen-low\x1b[0m\tGemini 4 Hydrogen (Low)',
  ].join('\n');
  assert.deepEqual(parseAntigravityModels(pipedOut), [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
  ]);

  const modelsOut = [
    'Fetching available models...',
    'gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)',
    'gemini-4-hydrogen-low          Gemini 4 Hydrogen (Low)',
    'gemini-pro-orchestrator-neon   Orchestrator (Neon)',
    'gemini-3.8-flash-low Gemini 3.8 Flash (Low)',
  ].join('\n');
  assert.equal(parseAntigravityModels(modelsOut).length, 4);
  assert.deepEqual(parseAntigravityAuthStatus(0, modelsOut, ''), {
    loggedIn: true,
    models: [
      { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
      { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
      { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    ],
  });
  assert.deepEqual(parseAntigravityModels('connection reset'), []);
  assert.deepEqual(
    parseAntigravityAuthStatus(0, '   \n', 'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\n'),
    { loggedIn: true, models: [{ id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' }] },
  );
  assert.deepEqual(
    parseAntigravityAuthStatus(1, 'Fetching available models...\n', 'Error: Please sign in to view available models.'),
    { loggedIn: false, models: [] },
  );
  const failedStatus = parseAntigravityAuthStatus(1, '', 'connection reset');
  assert.equal(failedStatus.loggedIn, false);
  assert.ok(failedStatus.error);

  assert.match(runInLang('en', () => friendlyAntigravityError('Please sign in')), /Sign in/);
  assert.match(runInLang('es', () => friendlyAntigravityError('Authentication required')), /Iniciar sesión/);
  assert.match(runInLang('en', () => friendlyAntigravityError('weekly rate limit reached')), /usage limit/);
  assert.match(runInLang('es', () => friendlyAntigravityError('429 quota exceeded')), /límite de uso/);
  assert.match(runInLang('en', () => friendlyAntigravityError('invalid model selection (--model "x")')), /does not include/);
  assert.match(runInLang('es', () => friendlyAntigravityError('not recognized as a known model')), /no incluye ese modelo/);
  assert.match(runInLang('de', () => friendlyAntigravityError('HTTP 401 Unauthorized')), /nicht angemeldet/);
  // Numbers and words that only contain the codes or "login" are not mistaken for them.
  assert.match(runInLang('en', () => friendlyAntigravityError('the answer used 1429 tokens and stopped')), /^Antigravity CLI: the answer/);
  assert.match(runInLang('en', () => friendlyAntigravityError('bad loginHint value')), /^Antigravity CLI: bad loginHint/);
});

test('preset, config and web search capability work for Antigravity', () => {
  const cfg = applyPreset({
    ...loadConfig(path.join(os.tmpdir(), 'no-config.json')),
    preset: 'antigravity',
    models: { antigravity: 'gemini-4-hydrogen' },
    efforts: { antigravity: 'medium' },
  });
  assert.equal(cfg.provider, 'antigravity');
  assert.equal(cfg.antigravity.model, 'gemini-4-hydrogen');
  assert.equal(cfg.antigravity.effort, 'medium');
  assert.equal(canSearch(cfg), true);
  assert.equal(canSearch({ ...cfg, webSearch: false }), false);
});

test('findAntigravity detects configured absolute paths and default Windows location', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-agy-find-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const custom = path.join(dir, 'custom-agy.cmd');
  fs.writeFileSync(custom, '@echo off\r\n');
  assert.deepEqual(findAntigravity(custom), { path: custom, source: 'config' });

  if (isWin) {
    const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE };
    process.env.LOCALAPPDATA = path.join(dir, 'Local');
    process.env.USERPROFILE = dir;
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const nativeExe = path.join(dir, 'Local', 'agy', 'bin', 'agy.exe');
    fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
    fs.writeFileSync(nativeExe, 'x');
    const found = findAntigravity(null);
    assert.deepEqual(found, { path: nativeExe, source: 'native' });
  }
});

// Stand-in for `agy`: logs args, stdin, settings file, and env; simulates models, effort fallback, and errors.
const FAKE_AGY = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const logFile = process.env.FAKE_AGY_LOG;
const record = (entry) => {
  const prev = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  prev.push(entry);
  fs.writeFileSync(logFile, JSON.stringify(prev));
};
if (args.includes('models')) {
  const isJson = args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json';
  record({ cmd: 'models', args, noUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE });
  if (process.env.FAKE_AGY_SIGNED_OUT === '1') {
    console.error('Error: Please sign in to view available models.');
    process.exit(1);
  }
  if (isJson && process.env.FAKE_AGY_LEGACY_MODELS === '1') {
    console.error('Error: flags provided but not defined: -output-format');
    process.exit(1);
  }
  if (isJson) {
    console.log(JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      response: 'gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)\\n',
      command: { name: 'models', data: { models: [{ id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' }] } },
    }));
  } else {
    console.log('gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)');
  }
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const settingsPath = args[args.indexOf('--settings') + 1];
  const rawSettings = fs.readFileSync(settingsPath);
  const hasBom = rawSettings[0] === 0xef && rawSettings[1] === 0xbb && rawSettings[2] === 0xbf;
  const settings = JSON.parse(rawSettings.toString('utf8'));
  record({ cmd: 'chat', args, stdin, settings, hasBom, noUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE });
  if (process.env.FAKE_AGY_ORCHESTRATOR === '1' && args.includes('--effort')) {
    console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: "Effort isn't adjustable for Orchestrator (Neon)." } }));
    process.exit(1);
  }
  if (process.env.FAKE_AGY_FAIL) {
    console.log(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: process.env.FAKE_AGY_FAIL } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-4-hydrogen-low' } }));
  console.log(JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: 'Ve a Minas de la Muerte.' } }));
  console.log(JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'Ve a Minas de la Muerte.',
      usage: { input_tokens: 120, output_tokens: 15, thinking_tokens: 5, cache_read_tokens: 40 },
    },
  }));
});
`;

test('asking through Antigravity end to end (fake agy in a folder with spaces)', { skip: !isWin }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake agy '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'fake-agy.mjs'), FAKE_AGY);
  const bin = path.join(dir, 'agy.cmd');
  fs.writeFileSync(bin, '@node "%~dp0fake-agy.mjs" %*\r\n');
  const logFile = path.join(dir, 'calls.json');
  process.env.FAKE_AGY_LOG = logFile;
  t.after(() => {
    delete process.env.FAKE_AGY_LOG;
    delete process.env.FAKE_AGY_FAIL;
    delete process.env.FAKE_AGY_SIGNED_OUT;
    delete process.env.FAKE_AGY_ORCHESTRATOR;
    delete process.env.FAKE_AGY_LEGACY_MODELS;
  });

  const cfg = applyPreset({ ...loadConfig(path.join(dir, 'none.json')), preset: 'antigravity', timeoutMs: 30000 });
  cfg.antigravity = { ...cfg.antigravity, bin };
  const messages = [{ role: 'user', content: '¿Qué hago ahora?' }];

  // Signed out: pre-check fails fast without hanging and returns localized sign-in error.
  process.env.FAKE_AGY_SIGNED_OUT = '1';
  await assert.rejects(runInLang('es', () => ask(cfg, 'Eres Fizzi.', messages, {})), /sesión iniciada/);
  delete process.env.FAKE_AGY_SIGNED_OUT;

  // Normal request with web search enabled.
  const r1 = await runInLang('es', () => ask(cfg, 'Eres Fizzi.', messages, {}));
  assert.equal(r1.text, 'Ve a Minas de la Muerte.');
  assert.match(r1.model, /Gemini 4 Hydrogen.*suscripción/);
  assert.deepEqual(r1.usage, { input: 120, cached: 40, output: 15 });

  let calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.equal(calls[0].cmd, 'models');
  assert.equal(calls[1].cmd, 'models');
  const chat1 = calls[2];
  assert.equal(chat1.noUpdate, 'true');
  assert.equal(chat1.hasBom, false);
  assert.deepEqual(chat1.settings.permissions.allow, ['read_url(*)']);
  assert.ok(chat1.settings.permissions.deny.includes('command(*)'));
  assert.ok(!fs.existsSync(chat1.args[chat1.args.indexOf('--settings') + 1]), 'temp settings file is removed');
  const prompt1 = JSON.parse(chat1.stdin.trim());
  assert.equal(prompt1.event, 'user');
  assert.match(prompt1.message.content, /^Eres Fizzi\./);
  assert.ok(prompt1.message.content.includes(ANTIGRAVITY_NOTE));
  assert.match(prompt1.message.content, /¿Qué hago ahora\?/);

  // Second request with webSearch: false reuses cached login and denies read_url(*).
  await runInLang('en', () => ask({ ...cfg, webSearch: false }, 'You are Fizzi.', messages, {}));
  calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.equal(calls.length, 4, 'cached login skipped agy models');
  assert.deepEqual(calls[3].settings.permissions.allow, []);
  assert.ok(calls[3].settings.permissions.deny.includes('read_url(*)'));

  // Effort fallback retry when account default is Orchestrator.
  process.env.FAKE_AGY_ORCHESTRATOR = '1';
  const rOrch = await runInLang('en', () => ask(cfg, 'You are Fizzi.', messages, {}));
  assert.equal(rOrch.text, 'Ve a Minas de la Muerte.');
  calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.ok(calls[4].args.includes('--effort'));
  assert.ok(!calls[5].args.includes('--effort'), 'retried without --effort');
  delete process.env.FAKE_AGY_ORCHESTRATOR;

  // Quota error in EN and ES.
  process.env.FAKE_AGY_FAIL = 'weekly rate limit reached';
  await assert.rejects(runInLang('en', () => ask(cfg, 's', messages, {})), /Google AI plan's usage limit/);
  await assert.rejects(runInLang('es', () => ask(cfg, 's', messages, {})), /límite de uso de tu plan de Google AI/);

  // Auth error clears cached login so next call re-checks `agy models`.
  process.env.FAKE_AGY_FAIL = 'Authentication required';
  await assert.rejects(runInLang('en', () => ask(cfg, 's', messages, {})), /Sign in/);
  delete process.env.FAKE_AGY_FAIL;
  await runInLang('en', () => ask(cfg, 's', messages, {}));
  calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.equal(calls.at(-2).cmd, 'models', 'login cache was invalidated by auth failure');

  // Legacy CLI without `--output-format` falls back cleanly to plain `agy models`.
  process.env.FAKE_AGY_LEGACY_MODELS = '1';
  const legacyStatus = await antigravityAuthStatus(bin);
  assert.equal(legacyStatus.loggedIn, true);
  assert.deepEqual(legacyStatus.models, [{ id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' }]);
  calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.deepEqual(calls.at(-2).args, ['--output-format', 'json', 'models']);
  assert.deepEqual(calls.at(-1).args, ['models']);
  delete process.env.FAKE_AGY_LEGACY_MODELS;
});

test('controller and server expose antigravity status and preset flow', { skip: !isWin }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-agy-ctrl-'));
  const prevDataDir = env.dataDir;
  env.dataDir = path.join(dir, 'data');
  t.after(() => {
    env.dataDir = prevDataDir;
    delete process.env.FAKE_AGY_LOG;
    delete process.env.FAKE_AGY_SIGNED_OUT;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const wowDir = path.join(dir, 'World of Warcraft', '_forever_');
  fs.mkdirSync(path.join(wowDir, 'Interface', 'AddOns'), { recursive: true });
  fs.mkdirSync(path.join(wowDir, 'WTF'), { recursive: true });

  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fake-agy.mjs'), FAKE_AGY);
  const bin = path.join(dir, 'agy.cmd');
  fs.writeFileSync(bin, '@node "%~dp0fake-agy.mjs" %*\r\n');
  process.env.FAKE_AGY_LOG = path.join(dir, 'ctrl-calls.json');
  process.env.FAKE_AGY_SIGNED_OUT = '1';
  fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({
    wowDir,
    antigravity: { bin },
  }));

  const controller = createController({ log: () => {} });
  const server = createServer(controller, { log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    controller.stop();
    server.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body = {}) => fetch(`${base}/api/${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forever-ai-companion': '1' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  await post('install-addon');
  await post('set-ai', { preset: 'antigravity', model: 'gemini-4-hydrogen', effort: 'medium' });
  const signedOut = await post('antigravity-status');
  assert.equal(signedOut.installed, true);
  assert.equal(signedOut.loggedIn, false);

  let status = await fetch(`${base}/api/status`).then((r) => r.json());
  assert.equal(status.ai.preset, 'antigravity');
  assert.equal(status.ai.models.antigravity, 'gemini-4-hydrogen');
  assert.equal(status.ai.efforts.antigravity, 'medium');
  assert.equal(status.ai.issue, 'need-login');

  delete process.env.FAKE_AGY_SIGNED_OUT;
  const signedIn = await post('antigravity-status');
  assert.equal(signedIn.installed, true);
  assert.equal(signedIn.loggedIn, true);
  assert.ok(signedIn.models.length > 0);

  status = await fetch(`${base}/api/status`).then((r) => r.json());
  assert.equal(status.ai.issue, null);
});

test('app window I18N has every key in English and Spanish with matching placeholders', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'app', 'ui.html'), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const fn = new Function(`${script.slice(0, script.indexOf('const I18N_MAC ='))}; return I18N;`);
  const i18n = fn();
  const enKeys = Object.keys(i18n.en);
  const esKeys = Object.keys(i18n.es);
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const k of enKeys) {
    assert.ok(k in i18n.es, `missing Spanish UI key: ${k}`);
    assert.equal(vars(i18n.es[k]), vars(i18n.en[k]), `UI placeholders differ: ${k}`);
  }
  for (const k of esKeys) {
    assert.ok(k in i18n.en, `extra Spanish UI key missing in English: ${k}`);
  }
});

test('Antigravity OAuth URL, pasted code validation, and localized login errors', () => {
  const codeUrl = `https://accounts.google.com/o/oauth2/auth?response_type=code&state=st-1&redirect_uri=${encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI)}`;
  const parsedCode = parseAntigravityAuthUrl(codeUrl, 'code');
  assert.deepEqual(parsedCode, { authUrl: codeUrl, redirectUri: ANTIGRAVITY_CODE_REDIRECT_URI, state: 'st-1' });
  assert.equal(parseAntigravityAuthUrl(codeUrl, 'loopback'), null);

  const loopUrl = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=st-loop&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F';
  assert.deepEqual(parseAntigravityAuthUrl(loopUrl, 'loopback'), {
    authUrl: loopUrl,
    redirectUri: 'http://127.0.0.1:51234/',
    state: 'st-loop',
  });
  assert.deepEqual(
    parseAntigravityAuthUrl('https://accounts.google.com/o/oauth2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A45678%2Foauth-callback', 'loopback')?.state,
    's',
  );

  // Reject malformed or untrusted auth URLs.
  assert.equal(parseAntigravityAuthUrl('https://evil.example/o/oauth2/auth?response_type=code&state=s&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback', 'code'), null);
  assert.equal(parseAntigravityAuthUrl('https://accounts.google.com/o/oauth2/auth?response_type=token&state=s&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback', 'code'), null);
  assert.equal(parseAntigravityAuthUrl('https://accounts.google.com/o/oauth2/auth?response_type=code&state=s&state=s2&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback', 'code'), null);
  assert.equal(parseAntigravityAuthUrl('https://accounts.google.com/o/oauth2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A80%2F', 'loopback'), null);
  assert.equal(parseAntigravityAuthUrl(`${codeUrl} extra`, 'code'), null);
  assert.equal(parseAntigravityAuthUrl(`${codeUrl}#frag`, 'code'), null);

  // Pasted code or full callback URL validation.
  assert.equal(parseAntigravityLoginCode(parsedCode, '  4/0AeanS0_xyz-123  \n'), '4/0AeanS0_xyz-123');
  const fullCallback = `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=st-1&code=4%2F0AeanS0_xyz`;
  assert.equal(parseAntigravityLoginCode(parsedCode, fullCallback), fullCallback);
  assert.equal(parseAntigravityLoginCode(parsedCode, ''), null);
  assert.equal(parseAntigravityLoginCode(parsedCode, 'abc\ndef'), null);
  assert.equal(parseAntigravityLoginCode(parsedCode, `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=WRONG&code=abc`), null);
  assert.equal(parseAntigravityLoginCode(parsedCode, `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=st-1`), null);
  assert.equal(parseAntigravityLoginCode(parsedCode, 'https://evil.example/oauth-callback?state=st-1&code=abc'), null);

  assert.match(runInLang('en', () => friendlyAntigravityLoginError('Error: unknown command "acp"')), /too old/);
  assert.match(runInLang('es', () => friendlyAntigravityLoginError('flag provided but not defined: -login')), /demasiado antigua/);
  assert.match(runInLang('en', () => friendlyAntigravityLoginError('SUBSCRIPTION_REQUIRED')), /eligible Antigravity plan/);
  assert.match(runInLang('es', () => friendlyAntigravityLoginError('access_denied')), /canceló/);
  assert.match(runInLang('en', () => friendlyAntigravityLoginError('couldn\'t log in: oauth2: "invalid_grant"')), /not accepted/);
  assert.match(runInLang('es', () => friendlyAntigravityLoginError('timed out')), /tardó demasiado/);
});

const FAKE_LOGIN_AGY = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const logFile = process.env.FAKE_LOGIN_LOG;
const authFile = process.env.FAKE_LOGIN_AUTH_FILE;
const record = (entry) => {
  if (!logFile) return;
  const prev = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : [];
  prev.push(entry);
  fs.writeFileSync(logFile, JSON.stringify(prev));
};

if (args.includes('models')) {
  const authed = authFile ? fs.existsSync(authFile) : process.env.FAKE_AGY_SIGNED_OUT !== '1';
  if (!authed) {
    console.error('Error: Please sign in to view available models.');
    process.exit(1);
  }
  console.log(JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response: 'gemini-4-hydrogen-low\\tGemini 4 Hydrogen (Low)\\n',
    command: { name: 'models', data: { models: [{ id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' }] } },
  }));
  process.exit(0);
}

if (args[0] === 'acp' && process.env.FAKE_LOGIN_OLD_CLI === '1') {
  console.error('Error: unknown command "acp" for "agy"');
  process.exit(1);
}

if (args[0] === 'acp' && args.includes('--stdio')) {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\\r?\\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        record({ cmd: 'acp-init', noUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE });
        console.log(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }] },
        }));
      } else if (msg.method === 'authenticate') {
        const mode = process.env.FAKE_ACP_MODE || 'delayed';
        record({ cmd: 'acp-auth', methodId: msg.params?.methodId, mode, noUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE });
        if (mode === 'immediate') {
          if (authFile) fs.writeFileSync(authFile, 'ok');
          console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
        } else if (mode === 'delayed') {
          console.log('Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=loop1&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2F');
          setTimeout(() => {
            if (authFile) fs.writeFileSync(authFile, 'ok');
            console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
          }, Number(process.env.FAKE_ACP_DELAY_MS || 260));
        } else if (mode === 'no-browser') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: 'No browser is available here (this is a remote (SSH) session, so the browser\\'s sign-in redirect can\\'t reach this machine).' },
          }));
        } else if (mode === 'denied') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'access_denied' },
          }));
        }
      }
    }
  });
  setInterval(() => {}, 1000);
}

if (args[0] === 'acp' && args.includes('--login')) {
  record({ cmd: 'acp-login', pid: process.pid, noUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE });
  console.log('Open this link in a browser to log in with Google:\\n');
  console.log('  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=st-test-123\\n');
  console.log('Then paste the authorization code, or the full URL of the page you land on, and press Enter:');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    const idx = buf.indexOf('\\n');
    if (idx === -1) return;
    const code = buf.slice(0, idx).trim();
    record({ cmd: 'acp-login-code', code });
    if (process.env.FAKE_LOGIN_EXCHANGE_FAIL === '1') {
      console.log('\\ncouldn\\'t log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."');
      process.exit(1);
    }
    if (authFile) fs.writeFileSync(authFile, 'ok');
    process.exit(0);
  });
  setInterval(() => {}, 1000);
}
`;

test('startAntigravityLogin runs headless ACP OAuth and falls back to in-app code paste', { skip: !isWin }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-agy login '));
  fs.writeFileSync(path.join(dir, 'fake-login-agy.mjs'), FAKE_LOGIN_AGY);
  const bin = path.join(dir, 'agy.cmd');
  fs.writeFileSync(bin, '@node "%~dp0fake-login-agy.mjs" %*\r\n');
  const logFile = path.join(dir, 'login-calls.json');
  const authFile = path.join(dir, 'authed.flag');
  process.env.FAKE_LOGIN_LOG = logFile;
  process.env.FAKE_LOGIN_AUTH_FILE = authFile;
  t.after(async () => {
    await cancelAntigravityLogin();
    for (const k of ['FAKE_LOGIN_LOG', 'FAKE_LOGIN_AUTH_FILE', 'FAKE_ACP_MODE', 'FAKE_LOGIN_OLD_CLI', 'FAKE_LOGIN_EXCHANGE_FAIL']) {
      delete process.env[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 1. Tier 1 delayed browser callback transitions browser -> succeeded and triggers onLoggedIn.
  process.env.FAKE_ACP_MODE = 'delayed';
  let loggedInCount = 0;
  const opened = [];
  const s1 = await startAntigravityLogin(bin, dir, {
    settleMs: 120,
    openUrl: (u) => opened.push(u),
    onLoggedIn: () => { loggedInCount++; },
  });
  assert.equal(s1.phase, 'browser');
  assert.equal(s1.mode, 'acp');
  assert.equal(opened.length, 0, 'ACP mode lets agy open browser natively');

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && antigravityLoginState().phase !== 'succeeded') {
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(antigravityLoginState().phase, 'succeeded');
  assert.equal(loggedInCount, 1);
  let calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.equal(calls[0].cmd, 'acp-init');
  assert.equal(calls[1].cmd, 'acp-auth');
  assert.equal(calls[1].methodId, 'oauth-personal');
  assert.equal(calls[1].noUpdate, 'true');

  // 2. Immediate keyring auth succeeds before settleMs.
  process.env.FAKE_ACP_MODE = 'immediate';
  const s2 = await startAntigravityLogin(bin, dir, {
    settleMs: 600,
    openUrl: (u) => opened.push(u),
    onLoggedIn: () => { loggedInCount++; },
  });
  assert.equal(s2.phase, 'succeeded');
  assert.equal(loggedInCount, 2);

  // 3. No browser / SSH fallback spawns `agy acp --login`, opens browser URL, validates paste, and succeeds.
  process.env.FAKE_ACP_MODE = 'no-browser';
  try { fs.unlinkSync(authFile); } catch {}
  const s3 = await startAntigravityLogin(bin, dir, {
    settleMs: 1000,
    openUrl: (u) => opened.push(u),
    onLoggedIn: () => { loggedInCount++; },
  });
  assert.equal(s3.phase, 'code');
  assert.equal(s3.mode, 'code');
  assert.match(s3.authUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
  assert.equal(opened.length, 1);
  assert.equal(opened[0], s3.authUrl);

  // Invalid pastes keep the login session alive so user can correct and retry.
  await assert.rejects(runInLang('en', () => submitAntigravityLoginCode('')), /Paste the code/);
  await assert.rejects(runInLang('es', () => submitAntigravityLoginCode('bad\ncode')), /Pega el código/);
  await assert.rejects(
    runInLang('en', () => submitAntigravityLoginCode(`${ANTIGRAVITY_CODE_REDIRECT_URI}?state=wrong&code=abc`)),
    /Paste the code/,
  );
  assert.equal(antigravityLoginState().phase, 'code');

  const submit1 = await submitAntigravityLoginCode('4/0AeanS0_good_code');
  assert.equal(submit1.ok, true);
  assert.equal(submit1.login.phase, 'succeeded');
  assert.equal(loggedInCount, 3);
  assert.equal(fs.existsSync(authFile), true);
  calls = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  assert.equal(calls.at(-1).cmd, 'acp-login-code');
  assert.equal(calls.at(-1).code, '4/0AeanS0_good_code');

  // 4. Full callback URL also works in direct code mode; cancel kills process tree cleanly.
  const s4 = await startAntigravityLogin(bin, dir, {
    mode: 'code',
    openUrl: (u) => opened.push(u),
  });
  assert.equal(s4.phase, 'code');
  const cbUrl = `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=st-test-123&code=4%2F0Afull`;
  const submit2 = await submitAntigravityLoginCode(cbUrl);
  assert.equal(submit2.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(logFile, 'utf8')).at(-1).code, cbUrl);

  // 5. Rejected exchange code surfaces localized error and sets phase = failed.
  process.env.FAKE_LOGIN_EXCHANGE_FAIL = '1';
  await startAntigravityLogin(bin, dir, { mode: 'code', openUrl: () => {} });
  await assert.rejects(runInLang('en', () => submitAntigravityLoginCode('4/0Abad')), /not accepted or has expired/);
  assert.equal(antigravityLoginState().phase, 'failed');
  delete process.env.FAKE_LOGIN_EXCHANGE_FAIL;

  // 6. Cancel cleans up running code-login child and resets state to idle.
  const s6 = await startAntigravityLogin(bin, dir, { mode: 'code', openUrl: () => {} });
  assert.equal(s6.phase, 'code');
  const loginPid = JSON.parse(fs.readFileSync(logFile, 'utf8')).filter((c) => c.cmd === 'acp-login').at(-1).pid;
  await cancelAntigravityLogin();
  assert.equal(antigravityLoginState().phase, 'idle');
  let alive = true;
  try { process.kill(loginPid, 0); } catch (e) { alive = e?.code === 'EPERM'; }
  assert.equal(alive, false, 'cancelled login process terminated');

  // 7. Denied consent and outdated CLI errors map cleanly.
  process.env.FAKE_ACP_MODE = 'denied';
  const sDenied = await runInLang('en', () => startAntigravityLogin(bin, dir, { settleMs: 1000 }));
  assert.equal(sDenied.phase, 'failed');
  assert.match(sDenied.error, /cancelled or not approved/);

  process.env.FAKE_LOGIN_OLD_CLI = '1';
  const sOld = await runInLang('en', () => startAntigravityLogin(bin, dir, { settleMs: 1000 }));
  assert.equal(sOld.phase, 'failed');
  assert.match(sOld.error, /too old/);
});

test('controller and server handle Antigravity auto-fallback and in-app code submission', { skip: !isWin }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-agy-login-http-'));
  const prevDataDir = env.dataDir;
  env.dataDir = path.join(dir, 'data');
  fs.mkdirSync(env.dataDir, { recursive: true });
  const authFile = path.join(dir, 'authed.flag');
  fs.writeFileSync(path.join(dir, 'fake-login-agy.mjs'), FAKE_LOGIN_AGY);
  const bin = path.join(dir, 'agy.cmd');
  fs.writeFileSync(bin, '@node "%~dp0fake-login-agy.mjs" %*\r\n');
  process.env.FAKE_LOGIN_AUTH_FILE = authFile;
  process.env.FAKE_ACP_MODE = 'no-browser';

  const wowDir = path.join(dir, 'World of Warcraft', '_forever_');
  fs.mkdirSync(path.join(wowDir, 'Interface', 'AddOns'), { recursive: true });
  fs.mkdirSync(path.join(wowDir, 'WTF'), { recursive: true });
  fs.writeFileSync(path.join(env.dataDir, 'config.json'), JSON.stringify({ wowDir, antigravity: { bin } }));

  const openedUrls = [];
  const controller = createController({ log: () => {}, openUrl: (u) => openedUrls.push(u) });
  const server = createServer(controller, { log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    stopAntigravityLogin();
    controller.stop();
    server.close();
    env.dataDir = prevDataDir;
    delete process.env.FAKE_LOGIN_AUTH_FILE;
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DELAY_MS;
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body = {}) => {
    const res = await fetch(`${base}/api/${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forever-ai-companion': '1' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  await post('install-addon');
  await post('set-ai', { preset: 'antigravity', model: 'default', effort: 'low' });

  const loginRes = await post('antigravity-login', { mode: 'auto' });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.loggedIn, false);
  assert.equal(loginRes.json.login.phase, 'code');
  assert.equal(openedUrls.length, 1);

  const stCode = await post('antigravity-status');
  assert.equal(stCode.json.loggedIn, false);
  assert.equal(stCode.json.login.phase, 'code');

  const badSubmit = await post('antigravity-login-code', { code: 'bad\ncode' });
  assert.equal(badSubmit.status, 400);

  const goodSubmit = await post('antigravity-login-code', { code: '4/0Avalid-via-http' });
  assert.equal(goodSubmit.status, 200);
  assert.equal(goodSubmit.json.loggedIn, true);
  assert.equal(goodSubmit.json.login.phase, 'idle');

  const status = await fetch(`${base}/api/status`).then((r) => r.json());
  assert.equal(status.ai.issue, null);

  // Explicit code mode + cancel route.
  const codeOnly = await post('antigravity-login', { mode: 'code' });
  assert.equal(codeOnly.status, 200);
  assert.equal(codeOnly.json.login.phase, 'code');
  const cancelled = await post('antigravity-login-cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.login.phase, 'idle');

  // Automatic ACP browser callback flow via HTTP (`delayed` success -> status updates automatically).
  try { fs.unlinkSync(authFile); } catch {}
  process.env.FAKE_ACP_MODE = 'delayed';
  process.env.FAKE_ACP_DELAY_MS = '1500';
  const acpLogin = await post('antigravity-login', { mode: 'auto' });
  assert.equal(acpLogin.status, 200);
  assert.equal(acpLogin.json.loggedIn, false);
  assert.equal(acpLogin.json.login.phase, 'browser');

  const deadline = Date.now() + 5000;
  let finalStatus;
  while (Date.now() < deadline) {
    finalStatus = await post('antigravity-status');
    if (finalStatus.json.loggedIn) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(finalStatus.json.loggedIn, true);
  assert.equal(finalStatus.json.login.phase, 'idle');
});
