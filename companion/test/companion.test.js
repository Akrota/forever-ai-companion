// Companion side: install into a fake WoW folder, process a screenshot
// request with the "echo" provider, and check what the addon would load.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, wowPaths } from '../src/config.js';
import { install } from '../src/install.js';
import { handleRequest, readRequest } from '../src/watcher.js';
import { cleanAnswer, buildSystem, flattenPrompt } from '../src/prompt.js';
import { anthropicWebTools, canSearch } from '../src/providers.js';
import { claudeCodeArgs } from '../src/providers.js';
import { applyPreset } from '../src/config.js';
import { luaString as toLuaString } from '../src/inbox.js';
import { encodePNG, renderGrid, runLua } from './helpers.js';

function tempWow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azia-wow-'));
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  return dir;
}

test('install creates addon, slots and empty signal files', () => {
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: tempWow(), slots: 3, signals: 5 };
  const p = install(cfg, { log: () => {}, resetState: false });
  assert.ok(fs.existsSync(path.join(p.addonDir, 'AzerothIA.toc')));
  assert.equal(fs.statSync(p.signal(1)).size, 0);
  assert.ok(fs.statSync(p.okSignal).size > 44);
  const toc = fs.readFileSync(path.join(p.slotDir(3), 'AzerothIA_S03.toc'), 'utf8');
  assert.match(toc, /## LoadOnDemand: 1/);
  assert.match(toc, /## Interface: 16001/);
});

test('screenshot request -> answer in every slot + signal rung', async () => {
  const cfg = { ...loadConfig(path.join(os.tmpdir(), 'no-config.json')), wowDir: tempWow(), slots: 3, signals: 5, provider: 'echo' };
  const p = install(cfg, { log: () => {}, resetState: false });

  // The addon builds the request (real Lua) and "takes the screenshot".
  const out = runLua(`
    local json = ns.Json.Encode({ v = 1, id = "abc123", sig = 2, question = "¿Dónde estoy?",
      context = { character = { name = "Thoradin", class = "Paladín", level = 24, race = "Enano" },
                  position = { zone = "Montañas de Alterac", x = 38.2, y = 46.7 } } })
    local W, H, cells = ns.Uplink.BuildGrid(ns.Uplink.Frame(json), 240)
    RESULT = W .. "," .. H .. "," .. table.concat(cells, ",")`);
  const [W, H, ...cells] = out.split(',').map(Number);
  const shot = path.join(p.screenshots, 'WoWScrnShot_111226_211500.png');
  fs.writeFileSync(shot, encodePNG(renderGrid(W, H, cells, { pitch: 6.2, noise: 5 })));

  const req = readRequest(shot);
  assert.equal(req.question, '¿Dónde estoy?');

  const state = { nextSig: 1, answers: [], processed: [] };
  const answer = await handleRequest(req, { cfg, paths: wowPaths(cfg.wowDir), state, system: buildSystem(''), save: () => {} });
  assert.ok(answer.ok);
  assert.match(answer.answer, /Thoradin, Enano Paladín nivel 24/);

  // The addon asked for signal 2, so that one must now be playable.
  assert.equal(fs.statSync(p.signal(1)).size, 0);
  assert.ok(fs.statSync(p.signal(2)).size > 44);
  assert.equal(state.nextSig, 3);

  // Same request again (e.g. duplicate screenshot) is ignored.
  assert.equal(await handleRequest(req, { cfg, paths: wowPaths(cfg.wowDir), state, system: '', save: () => {} }), null);

  // What LoadAddOn would execute: Inbox.lua must be valid Lua with the answer.
  const inbox = fs.readFileSync(path.join(p.slotDir(2), 'Inbox.lua'), 'utf8');
  const result = runLua(`
    local chunk = assert(load(INBOX))
    chunk()
    local a = AzerothIA_Inbox.answers[1]
    RESULT = a.id .. "|" .. tostring(a.ok) .. "|" .. a.answer`, { INBOX: inbox }, []);
  const [id, ok, text] = result.split('|');
  assert.equal(id, 'abc123');
  assert.equal(ok, 'true');
  assert.equal(text, answer.answer);
});

test('inbox escaping survives quotes, backslashes, newlines and accents', () => {
  const tricky = 'Dijo "hola" \\ y luego\nnueva línea ]] [[ --[[ ñandú\ttab';
  const out = runLua(`
    local chunk = assert(load(INBOX))
    chunk()
    RESULT = AzerothIA_Inbox.answers[1].answer`,
  { INBOX: `AzerothIA_Inbox = { answers = { { answer = ${toLuaString(tricky)} } } }` }, []);
  assert.equal(out, tricky);
});

test('cleanAnswer strips markdown and emoji for the WoW font', () => {
  const raw = '## Ruta\n**Minas de la Muerte** 🗡️ es tu mejor opción.\n* Ve a `Páramos de Poniente (42, 72)`\n\n\n\nSuerte';
  assert.equal(cleanAnswer(raw), 'Ruta\nMinas de la Muerte  es tu mejor opción.\n- Ve a Páramos de Poniente (42, 72)\n\nSuerte');
});

test('subscription mode runs Claude Code as a plain chat model', () => {
  const args = claudeCodeArgs({ model: 'sonnet', effort: 'low' }, 'C:\\tmp\\sys.txt', false);
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--system-prompt-file'), 'C:\\tmp\\sys.txt');
  assert.ok(args.includes('--no-session-persistence'), 'nothing saved in ~/.claude/projects');
  assert.equal(at('--tools'), '', 'no tools');
  assert.equal(at('--setting-sources'), '', 'no user settings or CLAUDE.md');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(at('--model'), 'sonnet');
  assert.equal(at('--effort'), 'low');
  // Through cmd.exe (claude.cmd) the empty values must be quoted to survive.
  const viaShell = claudeCodeArgs({ model: 'default' }, 'x', true);
  assert.equal(viaShell[viaShell.indexOf('--tools') + 1], '""');
  assert.ok(!viaShell.includes('--model'), '"default" leaves the plan default');
  // The prompt sent on stdin no longer repeats the system prompt.
  assert.ok(!flattenPrompt(null, [{ role: 'user', content: 'hola' }]).startsWith('null'));
  // The model picked in the window reaches the provider.
  const cfg = applyPreset({ preset: 'claude-code', models: { 'claude-code': 'haiku' }, claudeCode: { bin: 'claude' } });
  assert.equal(cfg.provider, 'claude-code');
  assert.equal(cfg.claudeCode.model, 'haiku');
});
test('each assistant has its own personality over the same rules', () => {
  const fizzi = buildSystem('', 'fizzi');
  const rizzik = buildSystem('', 'rizzik');
  assert.match(fizzi, /Fizzi Chispatuerca/);
  assert.match(rizzik, /Rizzik/);
  assert.ok(!rizzik.includes('Fizzi'), 'no mixing of personalities');
  for (const s of [fizzi, rizzik]) assert.match(s, /Formato de la respuesta/);
  assert.match(buildSystem('', undefined), /Fizzi/, 'old addons without the field get Fizzi');
  assert.match(buildSystem('', '<script>'), /Fizzi/, 'unknown names are ignored');
  assert.match(buildSystem('Dato del servidor', 'rizzik'), /Conocimiento del servidor[\s\S]*Dato del servidor/);
});
test('the AI knows WoW Forever and searches only when it can', () => {
  const withSearch = buildSystem('', 'fizzi', { canSearch: true });
  const without = buildSystem('', 'fizzi', { canSearch: false });
  assert.match(withSearch, /4 de noviembre de 2026/, 'explains Forever is newer than the model');
  assert.match(withSearch, /The Drowned City/, 'built-in Forever guide is included');
  assert.match(withSearch, /## Buscar en internet/);
  assert.match(without, /No puedes buscar en internet/);
  assert.match(withSearch, /Nunca incluyas enlaces/);

  // Which providers search, and with what.
  assert.equal(canSearch({ provider: 'claude-code' }), true);
  assert.equal(canSearch({ provider: 'anthropic', webSearch: false }), false);
  assert.equal(canSearch({ provider: 'openai' }), false);
  assert.deepEqual(anthropicWebTools('claude-opus-5-5').map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.deepEqual(anthropicWebTools('claude-haiku-5-5').map((t) => t.type), ['web_search_20250305']);

  // Subscription: only web tools, allowed without asking.
  const args = claudeCodeArgs({ model: 'sonnet' }, 'x', false, { webSearch: true });
  assert.equal(args[args.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
});

test('answers never carry links or source lists (the game cannot open them)', () => {
  const raw = 'La entrada está en Tuercespina (21, 28), según [Warcraft Tavern](https://www.warcrafttavern.com/forever/guides/x/).\n\nFuentes:\n- [Guía](https://example.com)';
  const out = cleanAnswer(raw);
  assert.equal(out, 'La entrada está en Tuercespina (21, 28), según Warcraft Tavern.');
  assert.equal(cleanAnswer('Mira https://wowhead.com/quest=70 para más.'), 'Mira  para más.'.replace('  ', ' '));
});