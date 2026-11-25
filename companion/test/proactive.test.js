// Proactive mode: what the app does with a tip (watcher guard, prompt) and the
// addon's rules (Proactive.lua, ZoneLevels.lua), run with the real Lua.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../src/config.js';
import { buildMessages, buildSystem } from '../src/prompt.js';
import { handleRequest } from '../src/watcher.js';
import { wowPaths } from '../src/config.js';
import { runLua } from './helpers.js';

// App side ------------------------------------------------------------------------

test('the prompt asks for a short tip and leaves out the player\'s chat history', () => {
  const normal = buildSystem('', 'fizzi', {});
  const tip = buildSystem('', 'fizzi', { proactive: { kind: 'level', key: 'level:12' } });
  assert.ok(!/Proactive tip/.test(normal));
  assert.match(tip, /## Proactive tip/);
  assert.ok(tip.startsWith(normal), 'the long part stays the same, so it can be cached');
  const history = [{ q: 'hola', a: 'hola!' }];
  assert.equal(buildMessages({ question: 'q', history }).length, 3);
  assert.equal(buildMessages({ question: 'q', history, proactive: { kind: 'level' } }).length, 1);
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-pro-'));
  const paths = wowPaths(dir);
  fs.mkdirSync(paths.sigDir, { recursive: true });
  for (let i = 1; i <= 2; i++) fs.mkdirSync(paths.slotDir(i), { recursive: true });
  return { dir, paths, state: { processed: [], answers: [], nextSig: 1 } };
}

test('an unknown tip is dropped; a known one is answered (the game decides which moments are on)', async (t) => {
  const { dir, paths, state } = setup();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const cfg = { ...DEFAULTS, provider: 'echo', slots: 2, signals: 5, keepAnswers: 10 };
  const system = () => { calls.push('system'); return ''; };
  const base = { cfg, paths, state, system, save: () => {}, log: () => {} };

  const unknown = await handleRequest({ id: 'a1', question: 'x', proactive: { kind: 'nope' } }, base);
  assert.equal(unknown, null);
  assert.deepEqual(calls, [], 'no AI call');
  assert.deepEqual(state.answers.at(-1), { id: 'a1', ok: false, answer: '', skipped: true });
  const inbox = fs.readFileSync(`${paths.slotDir(1)}/Inbox.lua`, 'utf8');
  assert.match(inbox, /skipped = true/);

  const events = [];
  const answered = await handleRequest({ id: 'a2', question: 'We entered Westfall', proactive: { kind: 'zone', key: 'zone:Westfall' } }, { ...base, onEvent: (e) => events.push(e) });
  assert.equal(answered.ok, true, 'the game already decided this moment is on');
  assert.equal(events[0].type, 'question');
});

// Addon side ----------------------------------------------------------------------

const LUA_FILES = ['Locale.lua', 'ZoneLevels.lua', 'Proactive.lua'];
const LUA_STUBS = `
  NOW = 1000
  GetTime = function() return NOW end
  GetLocale = function() return "enUS" end
  C_Timer = { After = function(_, fn) fn() end }
  LEVEL = 12
  UnitLevel = function() return LEVEL end
  ZONE = "Westfall"
  GetRealZoneText = function() return ZONE end
  SKILLS = {}
  GetNumSkillLines = function() return #SKILLS end
  GetSkillLineInfo = function(i) local s = SKILLS[i]; return s[1], s[2], 0, s[3] end
  ASKED = {}
`;
const SETUP = `
  ns.db = { chats = {}, proactive = ns.Proactive.Sanitize({ enabled = true }) }
  ns.Core = { CharData = function() ns.db.char = ns.db.char or {}; return ns.db.char end }
  ns.Proactive.queue, ns.Proactive.verifying = {}, {}
  local function queued()
    local out = {}
    for _, q in ipairs(ns.Proactive.queue) do out[#out + 1] = q.key end
    return table.concat(out, ",")
  end
`;
const lua = (script) => runLua(SETUP + script, {}, LUA_FILES, LUA_STUBS);

test('the options page loads and waits for the addon to finish loading', () => {
  const out = runLua(`RESULT = "loaded"`, {}, ['Locale.lua', 'Proactive.lua', 'Options.lua'], `
    CreateFrame = function()
      return { RegisterEvent = function() end, SetScript = function() end, UnregisterEvent = function() end }
    end
  `);
  assert.equal(out, 'loaded');
});

test('levels: every N levels from 2 up to the cap', () => {
  const out = lua(`
    local due = {}
    for _, every in ipairs({ 1, 2, 5 }) do
      local list = {}
      for level = 1, 61 do if ns.Proactive.LevelDue(level, every, 60) then list[#list + 1] = level end end
      due[#due + 1] = table.concat(list, ",", 1, math.min(#list, 4)) .. "/" .. #list
    end
    RESULT = table.concat(due, " ")
  `);
  assert.equal(out, '2,3,4,5/59 2,4,6,8/30 5,10,15,20/12');
});

test('a level-up queues one tip, and only for enabled moments', () => {
  const out = lua(`
    ns.Proactive:OnLevelUp(11)
    local odd = queued()
    ns.Proactive:OnLevelUp(12)
    ns.Proactive:OnLevelUp(12)
    local twice = queued()
    ns.db.char.proactive.seen["level:12"] = true
    ns.Proactive.queue = {}
    ns.Proactive:OnLevelUp(12)
    local seen = queued()
    ns.db.char.proactive.seen = {}
    ns.db.proactive.level = false
    ns.Proactive:OnLevelUp(14)
    local off = queued()
    ns.db.proactive.level = true
    ns.db.proactive.enabled = false
    ns.Proactive:OnLevelUp(14)
    local master = queued()
    ns.db.proactive.enabled = true
    ns.db.proactiveOff = true
    ns.Proactive:OnLevelUp(14)
    local local_ = queued()
    RESULT = table.concat({ odd, twice, seen, off, master, local_ }, "|")
  `);
  assert.equal(out, '|level:12||||');
});

test('zones: only known zones that suit the level, once, after staying a while', () => {
  const out = lua(`
    local results = {}
    local function try(zone, level)
      ZONE, LEVEL = zone, level
      ns.Proactive.queue = {}
      ns.db.char = nil
      ns.Proactive:CheckZone()
      return queued()
    end
    results[1] = try("Westfall", 12)
    results[2] = try("Páramos de Poniente", 12)     -- Spanish name
    results[3] = try("Westfall", 40)                 -- too high
    results[4] = try("Westfall", 5)                  -- too low
    results[5] = try("Stormwind City", 12)           -- not a questing zone
    -- Flying through: gone by the time the wait is over.
    ns.db.char = nil; ns.Proactive.queue = {}
    ZONE, LEVEL = "Westfall", 12
    C_Timer.After = function(_, fn) ZONE = "Duskwood"; fn() end
    ns.Proactive:CheckZone()
    results[6] = queued()
    RESULT = table.concat(results, "|")
  `);
  assert.equal(out, 'zone:Westfall|zone:Páramos de Poniente||||');
});

test('professions: the first scan only takes note, then milestones and new professions give tips', () => {
  const out = lua(`
    SKILLS = { { "Professions", true }, { "Mining", false, 80 }, { "Cooking", false, 20 }, { "Two-Handed Axes", false, 100 } }
    -- First scan: Mining 80 already passed 75. Nothing is asked.
    ns.Proactive:ScanSkills()
    local first = queued()
    -- Mining reaches 150 (having passed 75 before): one tip.
    SKILLS[2][3] = 150
    ns.Proactive:ScanSkills()
    local milestone = queued()
    ns.Proactive.queue = {}
    -- The same skill again: nothing new.
    ns.Proactive:ScanSkills()
    local again = queued()
    -- A jump over two milestones: only the latest.
    SKILLS[2][3] = 230
    ns.Proactive:ScanSkills()
    local jump = queued()
    ns.Proactive.queue = {}
    -- A new profession (Spanish name too); weapon skills never count.
    SKILLS[#SKILLS + 1] = { "Herrería", false, 1 }
    ns.Proactive:ScanSkills()
    RESULT = table.concat({ first, milestone, again, jump, queued() }, "|")
  `);
  assert.equal(out, '|profession:Mining:150||profession:Mining:225|profession:Herrería:new');
});

test('talents: the first point gets a tip, then only points left unspent', () => {
  const out = lua(`
    POINTS = 1
    GetUnspentTalentPoints = function() return POINTS end
    ns.Proactive:OnPointsChanged(-1)     -- spent one
    local spent = queued()
    ns.Proactive:OnPointsChanged(1)      -- the character's first talent point
    local first = queued()
    ns.Proactive:OnPointsChanged(1)
    local again = queued()
    -- Next levels: a point that gets spent right away is no news.
    ns.Proactive.queue = {}
    LEVEL = 13; POINTS = 1; ns.Proactive:OnPointsChanged(1)
    local spentRightAway = queued()
    LEVEL = 14; POINTS = 2; ns.Proactive:OnPointsChanged(1)
    local two = queued()
    LEVEL = 15; POINTS = 3; ns.Proactive:OnPointsChanged(1)
    RESULT = table.concat({ spent, first, again, spentRightAway, two, queued() }, "|")
  `);
  assert.equal(out, '|talents:12|talents:12|||talents:15');
});

test('the queue keeps three, dropping old non-level tips first, and sends level-ups first', () => {
  const out = lua(`
    local p = ns.Proactive
    p:Enqueue("zone", "zone:A", "q")
    p:Enqueue("profession", "profession:B", "q")
    p:Enqueue("talents", "talents:1", "q")
    p:Enqueue("level", "level:4", "q")
    RESULT = queued()
  `);
  assert.equal(out, 'profession:B,talents:1,level:4');
});

// Sending, with the game and the app faked.
const SEND_STUBS = `
  InCombatLockdown = function() return false end
  UnitAffectingCombat = function() return false end
  UnitIsDeadOrGhost = function() return false end
  UnitOnTaxi = function() return false end
  IsInInstance = function() return false end
  STATE = "ready"
  CHECKS = 0
`;
const SEND_SETUP = `
  ns.Core.working, ns.Core.HasPending = false, function() return false end
  ns.Core.Ask = function(_, question, extra, chatId, again, opts)
    ASKED[#ASKED + 1] = extra.proactive.key .. ":" .. tostring(opts and opts.silent)
    return "id" .. #ASKED
  end
  ns.Uplink = { busy = false }
  ns.Personas = { Chosen = function() return true end }
  ns.Live = { CheckApp = function() CHECKS = CHECKS + 1 end, AppState = function() return STATE end }
  ns.Proactive.readyAt = 0
  local function tick(n) for _ = 1, n or 1 do NOW = NOW + 2; ns.Proactive:Tick() end end
`;
const send = (script) => runLua(SETUP + SEND_SETUP + script, {}, LUA_FILES, LUA_STUBS + SEND_STUBS);

test('a queued tip waits for the app, goes out silently once, and then for the cooldown', () => {
  const out = send(`
    ns.Proactive:Enqueue("level", "level:12", "q")
    tick(2)
    local early = #ASKED                       -- the app is still being checked
    tick(1)
    local sent = ASKED[1]
    ns.Proactive:Enqueue("zone", "zone:Westfall", "q")
    tick(5)                                    -- 10 s: inside the 3 minute cooldown
    local cooling = #ASKED
    NOW = NOW + 200
    tick(3)
    RESULT = table.concat({ early, sent, cooling, #ASKED, ASKED[2], tostring(ns.db.char.proactive.seen["level:12"]) }, "|")
  `);
  assert.equal(out, '0|level:12:true|1|2|zone:Westfall:true|true');
});

test('nothing is sent in combat, dead, on a flight path, in a loading screen or while a question is pending', () => {
  const out = send(`
    ns.Proactive:Enqueue("level", "level:12", "q")
    local blocked = {}
    local function block(name, undo, fn)
      fn(true)
      tick(6)
      blocked[#blocked + 1] = name .. "=" .. #ASKED
      fn(false)
    end
    block("combat", nil, function(on) InCombatLockdown = function() return on end end)
    block("dead", nil, function(on) UnitIsDeadOrGhost = function() return on end end)
    block("taxi", nil, function(on) UnitOnTaxi = function() return on end end)
    block("loading", nil, function(on) ns.Proactive.loading = on end)
    block("pending", nil, function(on) ns.Core.HasPending = function() return on end end)
    block("working", nil, function(on) ns.Core.working = on end)
    tick(4)
    RESULT = table.concat(blocked, ",") .. "|" .. #ASKED
  `);
  assert.equal(out, 'combat=0,dead=0,taxi=0,loading=0,pending=0,working=0|1');
});

test('in an instance only the dungeon tip goes out', () => {
  const out = send(`
    IsInInstance = function() return true, "party" end
    ns.Proactive:Enqueue("level", "level:12", "q")
    ns.Proactive:Enqueue("dungeon", "dungeon:Deadmines", "q")
    tick(6)
    local first = ASKED[1]
    NOW = NOW + 300
    tick(6)
    RESULT = first .. "|" .. #ASKED
  `);
  assert.equal(out, 'dungeon:Deadmines:true|1');
});

test('with the app closed the tips are dropped, with the app starting they wait, and old ones expire', () => {
  const out = send(`
    STATE = "checking"
    ns.Proactive:Enqueue("level", "level:12", "q")
    tick(6)
    local waiting = #ASKED .. "/" .. #ns.Proactive.queue
    STATE = "closed"
    tick(3)
    local closed = #ASKED .. "/" .. #ns.Proactive.queue
    STATE = "ready"
    ns.Proactive:Enqueue("level", "level:14", "q")
    NOW = NOW + 700
    tick(1)
    RESULT = table.concat({ waiting, closed, #ASKED .. "/" .. #ns.Proactive.queue }, "|")
  `);
  assert.equal(out, '0/1|0/0|0/0');
});

test('/ia proactive reports and switches off locally', () => {
  const out = send(`
    ns.db.proactive = nil
    local none = ns.Proactive:Command("")
    ns.db.proactive = ns.Proactive.Sanitize({ enabled = true, zone = false })
    ns.Proactive:Enqueue("level", "level:12", "q")
    local on = ns.Proactive:Command("")
    local off = ns.Proactive:Command("off")
    local after = ns.Proactive:Command("") .. "/" .. #ns.Proactive.queue
    ns.Proactive:Enqueue("level", "level:14", "q")
    local blocked = #ns.Proactive.queue
    ns.Proactive:Command("on")
    RESULT = table.concat({ none, on, off, after, blocked, tostring(ns.Proactive:Enabled("level")) }, "|")
  `);
  const [none, on, off, after, blocked, enabled] = out.split('|');
  assert.match(none, /Options → AddOns → Forever AI Companion/);
  assert.match(on, /on\. Waiting to be sent: 1\. Moments: level, dungeon, profession, talents\./);
  assert.match(off, /off in this game/);
  assert.match(after, /off on this PC.*\/0$/);
  assert.equal(blocked, '0');
  assert.equal(enabled, 'true');
});

test('the inbox settings are checked before the addon keeps them', () => {
  const out = lua(`
    ns.Proactive:SetSettings({ enabled = true, level = false, cooldownMin = 500, levelEvery = 3, zone = "x" })
    local s = ns.db.proactive
    ns.Proactive:SetSettings("garbage")
    RESULT = table.concat({ tostring(s.enabled), tostring(s.level), tostring(s.zone), s.cooldownMin, s.levelEvery, tostring(ns.db.proactive == s) }, "|")
  `);
  assert.equal(out, 'true|false|true|60|2|true');
});
