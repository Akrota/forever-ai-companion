// Runs the whole in-game send path (Core:Ask -> Collect -> Json -> Uplink:Send
// -> Draw -> Screenshot) against a fake WoW UI, then renders the textures the
// addon created and checks the companion can decode them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLua, encodePNG } from './helpers.js';
import { decodeImage } from '../src/image.js';
import { decodeGrid } from '../src/grid.js';

const FAKE_UI = `
  local function noop() end
  local function newRegion(kind, parent)
    local r = { kind = kind, parent = parent, shown = true, points = {}, w = 0, h = 0, alpha = 1, scripts = {} }
    local mt = { __index = function(t, k)
      if k == "SetPoint" then return function(self, p, rel, rp, x, y) self.x, self.y = x or 0, y or 0; self.anchored = true end end
      if k == "SetAllPoints" then return function(self) self.anchored = true end end
      if k == "SetSize" then return function(self, w, h) self.w, self.h = w, h end end
      if k == "Show" then return function(self) self.shown = true end end
      if k == "Hide" then return function(self) self.shown = false end end
      if k == "IsShown" then return function(self) return self.shown end end
      if k == "SetShown" then return function(self, v) self.shown = v end end
      if k == "SetColorTexture" then return function(self, r, g, b) self.color = { r, g, b } end end
      if k == "CreateTexture" then return function(self) local t = newRegion("Texture", self); TEXTURES[#TEXTURES + 1] = t; return t end end
      if k == "CreateFontString" then return function(self) return newRegion("FontString", self) end end
      if k == "SetScript" then return function(self, name, fn) self.scripts[name] = fn end end
      if k == "GetScript" then return function(self, name) return self.scripts[name] end end
      if k == "GetHeight" then return function(self) return self.h end end
      if k == "GetWidth" then return function(self) return self.w end end
      if k == "SetWidth" then return function(self, v) self.w = v end end
      if k == "SetHeight" then return function(self, v) self.h = v end end
      if k == "GetStringWidth" or k == "GetUnboundedStringWidth" then return function() return 100 end end
      if k == "IsMouseOver" then return function() return false end end
      if k == "IsEnabled" then return function() return true end end
      if k == "HookScript" then return function(self, name, fn)
        local prev = self.scripts[name]
        self.scripts[name] = function(...) if prev then prev(...) end fn(...) end
      end end
      if k == "GetAlpha" then return function(self) return self.alpha end end
      if k == "SetAlpha" then return function(self, a) self.alpha = a end end
      if k == "GetText" then return function() return "" end end
      if k == "GetStringHeight" then return function() return 10 end end
      if k == "GetVerticalScrollRange" then return function() return 0 end end
      return noop
    end }
    return setmetatable(r, mt)
  end
  TEXTURES = {}
  FRAMES = {}
  CreateFrame = function(kind, name, parent)
    local f = newRegion(kind, parent)
    FRAMES[#FRAMES + 1] = f
    if name then _G[name] = f end
    return f
  end
  CreateFont = function() return newRegion("Font") end
  WorldFrame = newRegion("Frame"); WorldFrame.h = 768
  UIParent = newRegion("Frame"); UIParent.h = 768
  GetPhysicalScreenSize = function() return 2560, 1440 end
  local cvars = { screenshotFormat = "jpeg", screenshotQuality = "3" }
  GetCVar = function(k) return cvars[k] end
  SetCVar = function(k, v) cvars[k] = v end
  NOW = 100
  GetTime = function() return NOW end
  time = os.time
  SHOTS = 0
  Screenshot = function() SHOTS = SHOTS + 1 end
  InCombatLockdown = function() return false end
  UnitAffectingCombat = function() return false end
  strtrim = function(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
  print = function() end
  C_Timer = { After = function(_, fn) end, NewTicker = function() end }
  PlaySoundFile = function() return false end
  UISpecialFrames = {}
  tinsert = table.insert
  SlashCmdList = {}
  date = os.date
  UnitName = function() return "Sharp" end
  UnitLevel = function() return 33 end
  UnitClass = function() return "Cazadora", "HUNTER" end
  UnitRace = function() return "Enana" end
  UnitExists = function(u) return u == "player" end
  GetRealmName = function() return "Forever" end
  GetInventoryItemLink = function() return nil end
  C_QuestLog = {
    GetNumQuestLogEntries = function() return 30 end,
    GetInfo = function(i) return { title = "Misión " .. i .. " con un nombre bastante largo", level = 30, questID = 1000 + i } end,
    GetQuestObjectives = function() return { { text = "Algo: 3/10", finished = false } } end,
  }
  GetQuestLogQuestText = function() return "d", "Mata 10 cosas y vuelve con el explorador en el campamento." end
`;

// Lua helpers: start the addon, ask, and dump what is on screen right away.
const PRELUDE_DRIVE = `
  function START()
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then
        f.scripts.OnEvent(f, "ADDON_LOADED", "AzerothIA")
        f.scripts.OnEvent(f, "PLAYER_LOGIN")
      end
    end
  end
  function RUN_FRAMES(n)
    for i = 1, n do
      for _, f in ipairs(FRAMES) do
        if f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end
      end
      NOW = NOW + 0.016
    end
  end
  -- Fake profiler clock: every call costs 0.5 ms, so a 4 ms budget is ~8 steps.
  local fakeMs = 0
  debugprofilestop = function() fakeMs = fakeMs + 0.5; return fakeMs end
  function FIRE(event, ...)
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end
    end
  end
  -- Asks and runs frames until the strip appears. Returns the dump and frame count.
  function ASK(q)
    ns.Core:Ask(q)
    for i = 1, 2000 do
      if ns.Uplink.grid and ns.Uplink.grid.shown then return DUMP(), i - 1 end
      RUN_FRAMES(1)
    end
    return DUMP(), -1
  end
  function DUMP()
    local grid = ns.Uplink.grid
    local out = {}
    for _, t in ipairs(TEXTURES) do
      if t.parent == grid and t.shown and rawget(t, "color") and rawget(t, "x") then
        out[#out + 1] = string.format("%.4f,%.4f,%.4f,%d,%d,%d", t.x, -t.y, t.w,
          math.floor(t.color[1] * 255 + 0.5), math.floor(t.color[2] * 255 + 0.5), math.floor(t.color[3] * 255 + 0.5))
      end
    end
    return tostring(grid.shown) .. ";" .. grid.w .. "," .. grid.h .. ";" .. table.concat(out, "|")
  end
`;

const FILES = ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Core.lua'];

// Renders a DUMP() like the screen would show it (UIParent: 768 units = 1440 px)
// and decodes it with the companion's decoder.
function decodeDump(dump) {
  const [shown, size, texList] = dump.split(';');
  assert.equal(shown, 'true', 'strip should be visible right after asking');
  const scale = 1440 / 768;
  const [gw, gh] = size.split(',').map(Number);
  const width = 2560, height = 160;
  assert.ok(gh * scale <= height, `strip too tall: ${gh * scale}px`);
  const data = Buffer.alloc(width * height * 3, 200); // bright game scene behind
  for (const t of texList.split('|')) {
    const [x, y, w, r, g, b] = t.split(',').map(Number);
    const x0 = Math.round(x * scale), y0 = Math.round(y * scale);
    const x1 = Math.round((x + w) * scale), y1 = Math.round((y + w) * scale);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * width + xx) * 3;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
  const payload = decodeGrid({ width, height, channels: 3, data });
  assert.ok(payload, 'strip not found');
  return { req: JSON.parse(payload.toString('utf8')), stripPx: Math.round(gh * scale) };
}

test('asking shows a thin strip (no screenshot, UI untouched) that decodes', () => {
  const out = runLua(`
    START()
    local first, frames = ASK("test")
    RUN_FRAMES(40)
    RESULT = first .. "#" .. frames .. ";" .. SHOTS .. ";" .. tostring(ns.Uplink.grid.shown) .. ";" .. tostring(ns.Uplink.busy) .. ";" .. UIParent.alpha
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [dump, after] = out.split('#');
  const [frames, shots, shownAfter, busy, alpha] = after.split(';');
  assert.ok(Number(frames) > 1, `preparation should be spread over several frames (took ${frames})`);
  assert.equal(shots, '0', 'no Screenshot() any more');
  assert.equal(alpha, '1', 'UI must not be hidden');
  assert.equal(shownAfter, 'false', 'strip disappears afterwards');
  assert.equal(busy, 'false');
  const { req, stripPx } = decodeDump(dump);
  assert.equal(req.question, 'test');
  assert.equal(req.context.quests.length, 30);
  assert.ok(stripPx <= 60, `strip is ${stripPx}px tall`);
});

test('second question only sends what changed (after the first was answered)', () => {
  const out = runLua(`
    START()
    local first = ASK("primera")
    RUN_FRAMES(40)
    -- the companion answers the first question
    local msgs = ns.Chats:Current().messages; local id = msgs[#msgs].id
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "ok" } } })
    -- one quest changes, everything else stays the same
    C_QuestLog.GetQuestObjectives = function(qid)
      if qid == 1005 then return { { text = "Algo: 4/10", finished = false } } end
      return { { text = "Algo: 3/10", finished = false } }
    end
    FIRE("QUEST_LOG_UPDATE")
    local second = ASK("segunda")
    RESULT = first .. "#" .. second
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [d1, d2] = out.split('#');
  const first = decodeDump(d1).req;
  const second = decodeDump(d2);
  assert.ok(first.hashes.character && first.hashes.quests);
  assert.deepEqual(Object.keys(second.req.same).sort(), Object.keys(first.hashes).filter((k) => k !== 'quests').sort());
  assert.ok(second.req.context.quests, 'changed section is sent');
  assert.equal(second.req.context.character, undefined, 'unchanged section is not sent');
  assert.ok(JSON.stringify(second.req).length < JSON.stringify(first).length);
});

test('/ia probar-canales runs every probe, undoes it and reports through the strip', () => {
  const probeApis = `
    CALLS = {}
    local function rec(name) return function(...) CALLS[#CALLS + 1] = name; return true end end
    C_Timer.After = function(_, fn) fn() end
    RegisterCVar = rec("RegisterCVar")
    SetCVar = function(k, v) CALLS[#CALLS + 1] = "SetCVar:" .. k .. "=" .. tostring(v) end
    C_AddOns = { DisableAddOn = rec("DisableAddOn"), EnableAddOn = rec("EnableAddOn"), SaveAddOns = rec("SaveAddOns"),
                 IsAddOnLoaded = function() return false end, LoadAddOn = function() return false, "MISSING" end }
    GetMacroIndexByName = function() return 0 end
    CreateMacro = rec("CreateMacro")
    local logging = false
    LoggingChat = function(v) if v ~= nil then logging = v end; return logging end
    C_ChatInfo = { RegisterAddonMessagePrefix = rec("RegisterPrefix"), SendAddonMessage = rec("SendAddonMessage") }
    C_VoiceChat = { GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft Helena Desktop" } } end,
                    SpeakText = rec("SpeakText") }
    FlashClientIcon = function() end
  `;
  const out = runLua(`
    START()
    ns.Probe:Run()
    for i = 1, 2000 do
      if ns.Uplink.grid and ns.Uplink.grid.shown then break end
      RUN_FRAMES(1)
    end
    RESULT = DUMP() .. "#" .. table.concat(CALLS, ",") .. "#" .. tostring(LoggingChat())
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE + probeApis);
  const [dump, calls, loggingAfter] = out.split('#');
  for (const c of ['SetCVar:aziaProbe=AZIA-PROBE-', 'DisableAddOn', 'SaveAddOns', 'CreateMacro', 'SendAddonMessage', 'SpeakText', 'EnableAddOn', 'SetCVar:aziaProbe=']) {
    assert.ok(calls.includes(c), `missing ${c} in ${calls}`);
  }
  assert.equal(loggingAfter, 'false', 'chat logging restored');
  const { req } = decodeDump(dump);
  assert.equal(req.question, 'Prueba de canales invisibles');
  assert.equal(req.probe.results.cvar, 'ok');
  assert.equal(req.probe.results.addons, 'ok');
  assert.equal(req.probe.ttsVoices[0].name, 'Microsoft Helena Desktop');
  assert.match(req.probe.token, /^\d+$/);
});

test('oversized requests are trimmed to the frame size limit', () => {
  const big = FAKE_UI.replace('return 30 end', 'return 120 end');
  const out = runLua(`
    START()
    ASK("grande")
    RESULT = ns.Uplink.last.bytes .. ";" .. ns.Uplink.MAX_FRAME_BYTES
  `, {}, FILES, big + PRELUDE_DRIVE);
  const [bytes, max] = out.split(';').map(Number);
  assert.ok(bytes <= max, `${bytes} > ${max}`);
});


test('chats: each chat keeps its own history, answers land in the right chat', () => {
  const out = runLua(`
    AzerothIA_DB = { history = { { id = "old1", question = "pregunta vieja", status = "done", answer = "respuesta vieja", t = 100 } } }
    START()
    local migrated = ns.Chats:Current()
    local a = ns.Chats:New()
    local dumpA1 = ASK("¿Qué mazmorra hago?")
    RUN_FRAMES(40)
    local idA1 = a.messages[1].id
    ns.Core:ApplyInbox({ answers = { { id = idA1, ok = true, answer = "Gnomeregan" } } })

    local b = ns.Chats:New()
    local dumpB1 = ASK("¿Cómo va mi equipo?")
    RUN_FRAMES(40)
    local idB1 = b.messages[1].id

    -- B's answer arrives while A is open: B gets the "new" mark.
    ns.Chats:Select(a.id)
    ns.Core:ApplyInbox({ answers = { { id = idB1, ok = true, answer = "Cambia las botas" } } })
    local bUnread = tostring(b.unread)

    local dumpA2 = ASK("¿Y después de Gnomeregan?")
    RUN_FRAMES(40)

    ns.Chats:Rename(b.id, "Mi equipo")
    ns.Chats:Delete(migrated.id)
    local titles = {}
    for _, c in ipairs(ns.Chats:All()) do titles[#titles + 1] = c.title end

    RESULT = migrated.title .. "|" .. #migrated.messages .. "#" .. dumpA1 .. "#" .. dumpB1 .. "#" .. dumpA2
      .. "#" .. a.title .. "|" .. tostring(a.messages[1].answer) .. "|" .. tostring(b.messages[1].answer) .. "|" .. bUnread
      .. "#" .. table.concat(titles, ",")
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [migrated, dA1, dB1, dA2, summary, titles] = out.split('#');
  assert.equal(migrated, 'Conversación anterior|1');
  const a1 = decodeDump(dA1).req;
  const b1 = decodeDump(dB1).req;
  const a2 = decodeDump(dA2).req;
  assert.deepEqual(a1.history, [], 'a new chat starts without history');
  assert.deepEqual(b1.history, [], 'chat B does not see chat A');
  assert.deepEqual(a2.history, [{ q: '¿Qué mazmorra hago?', a: 'Gnomeregan' }], 'chat A sees only its own turns');
  assert.equal(a2.chat.title, '¿Qué mazmorra hago?');
  const [aTitle, aAnswer, bAnswer, bUnread] = summary.split('|');
  assert.equal(aTitle, '¿Qué mazmorra hago?', 'title comes from the first question');
  assert.equal(aAnswer, 'Gnomeregan');
  assert.equal(bAnswer, 'Cambia las botas');
  assert.equal(bUnread, 'true');
  assert.deepEqual(titles.split(',').sort(), ['Mi equipo', '¿Qué mazmorra hago?'].sort());
});

test('floating button: opens the chats, new chat, unread badge, drag, hide', () => {
  const out = runLua(`
    IsShiftKeyDown = function() return SHIFT end
    START()
    local b = AzerothIAFloatingButton
    assert(b, "button not created")
    b.dragging = false -- the fake UI answers unknown fields with a function
    local shownAtStart = tostring(b.shown)
    b.scripts.OnClick(b, "LeftButton")
    local openedByClick = tostring(ns.UI.frame.shown)
    b.scripts.OnClick(b, "LeftButton")
    local closedBySecondClick = tostring(ns.UI.frame.shown)

    ns.Core:Ask("primera")           -- the open chat now has a message
    local before = #ns.db.chats
    b.scripts.OnClick(b, "RightButton")
    local newChat = tostring(#ns.db.chats == before + 1) .. "," .. tostring(ns.UI.frame.shown)

    ns.db.chats[1].unread = true
    ns.Button:Update()
    local badge = tostring(ns.Button.badge.shown) .. "," .. ns.Button.badgeText:GetText()
    local thinking = tostring(ns.Button.thinking)

    b.GetPoint = function() return "BOTTOMLEFT", UIParent, "BOTTOMLEFT", 300, 120 end
    b.scripts.OnDragStart(b)
    b.scripts.OnDragStop(b)
    local saved = ns.db.button.point .. "," .. ns.db.button.x .. "," .. ns.db.button.y
    b.dragging = false

    SHIFT = true
    b.scripts.OnClick(b, "RightButton")
    local hidden = tostring(b.shown) .. "," .. tostring(ns.db.button.shown)

    RESULT = table.concat({ shownAtStart, openedByClick, closedBySecondClick, newChat, badge, thinking, saved, hidden }, "#")
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [shownAtStart, opened, closed, newChat, badge, thinking, saved, hidden] = out.split('#');
  assert.equal(shownAtStart, 'true');
  assert.equal(opened, 'true');
  assert.equal(closed, 'false');
  assert.equal(newChat, 'true,true');
  assert.equal(badge.split(',')[0], 'true');
  assert.equal(thinking, 'true', 'a pending question makes the icon breathe');
  assert.equal(saved, 'BOTTOMLEFT,300,120');
  assert.equal(hidden, 'false,false');
});

test('window: welcome suggestions, bubbles, copy, retry, font size and sidebar', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    local ui = ns.UI
    ui:Refresh() -- the real game fires OnShow
    local welcomeShown = tostring(ui.welcome and ui.welcome.shown)
    local chips = #ui.welcome.chips

    -- A suggestion asks right away.
    ui.welcome.chips[1].scripts.OnClick(ui.welcome.chips[1])
    RUN_FRAMES(200)
    local current = ns.Chats:Current()
    local asked = current.messages[1].question

    -- Answer arrives: user bubble + AI bubble with "Copiar".
    ns.Core:ApplyInbox({ answers = { { id = current.messages[1].id, ok = true, answer = "Ve a Gnomeregan" } } })
    ui:Refresh()
    local shownBubbles = 0
    for _, b in ipairs(ui.bubbles) do if b.shown then shownBubbles = shownBubbles + 1 end end
    local aiBubble = ui.bubbles[2]
    aiBubble.action.scripts.OnClick(aiBubble.action)
    local copyOpen = tostring(ui.copyFrame and ui.copyFrame.shown)

    -- An error offers "Reintentar", which asks again in the same chat.
    current.messages[1].status = "error"
    current.messages[1].answer = "Error: sin conexión"
    ui:Refresh()
    ui.bubbles[2].action.scripts.OnClick(ui.bubbles[2].action)
    local retried = #current.messages .. "," .. current.messages[1].status

    ui:SetFontSize(40)
    local size = ns.db.ui.fontSize
    ui:SetSidebar(false)
    local sidebar = tostring(ui.side.shown) .. "," .. tostring(ns.db.ui.sidebar)

    RESULT = table.concat({ welcomeShown, chips, asked, shownBubbles, copyOpen, retried, size, sidebar }, "#")
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [welcome, chips, asked, bubbles, copyOpen, retried, size, sidebar] = out.split('#');
  assert.equal(welcome, 'true', 'empty chat shows the welcome screen');
  assert.equal(chips, '6');
  assert.equal(asked, '¿Qué mazmorra me conviene hacer ahora?');
  assert.equal(bubbles, '2', 'one bubble for the question, one for the answer');
  assert.equal(copyOpen, 'true');
  assert.equal(retried, '1,pending', 'retry replaces the failed question with a new attempt');
  assert.equal(size, '20', 'font size is capped');
  assert.equal(sidebar, 'false,false');
});

test('assistant: first open asks Fizzi or Rizzik, suggests by faction, themes everything', () => {
  const out = runLua(`
    UnitFactionGroup = function() return "Horde" end
    START()
    ns.UI:Show()
    local ui = ns.UI
    ui:Refresh()
    local chooserShown = tostring(ui.chooser and ui.chooser.shown)
    local welcomeHidden = tostring(not (ui.welcome and ui.welcome.shown))
    local cards = #ui.chooser.cards
    local back = tostring(ui.chooser.back.shown)           -- nothing chosen yet: no way back
    local suggested = ns.Personas:Suggested().id

    -- Pick Rizzik: window goes gold, welcome uses his texts, button shows him.
    local rizzikCard = ui.chooser.cards[2]
    rizzikCard.pick.scripts.OnClick(rizzikCard.pick)
    local chosen = ns.Personas:Current().id .. "," .. tostring(ns.Personas:Chosen())
    local afterPick = tostring(ui.chooser.shown) .. "," .. tostring(ui.welcome.shown)
    local accent = string.format("%.2f", ui.COLORS.accent[1])
    local hello = ui.welcome.hello.textValue or ""

    -- The question carries the assistant so the app uses its personality.
    ns.Core:Ask("hola")
    local pending = ""
    for i = 1, 200 do
      RUN_FRAMES(1)
      for _, b in ipairs(ui.bubbles) do if b.shown and b.pending then pending = b.text.textValue or "" end end
    end

    -- Header click opens the chooser again; switching back to Fizzi recolors.
    ui:ShowChooser()
    local reopened = tostring(ui.chooser.shown) .. "," .. tostring(ui.chooser.back.shown)
    ui.chooser.cards[1].pick.scripts.OnClick(ui.chooser.cards[1].pick)
    local accent2 = string.format("%.2f", ui.COLORS.accent[1])

    RESULT = table.concat({ chooserShown, welcomeHidden, cards, back, suggested, chosen, afterPick,
      accent, hello, pending, reopened, accent2, ns.Personas:Current().id }, "#")
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI.replace('GetStringHeight" then return function() return 10 end end',
    'GetStringHeight" then return function() return 10 end end\n      if k == "SetText" then return function(self, v) self.textValue = v end end') + PRELUDE_DRIVE);
  const [chooser, welcomeHidden, cards, back, suggested, chosen, afterPick, accent, hello, pending, reopened, accent2, final] = out.split('#');
  assert.equal(chooser, 'true', 'the first time, the window asks for an assistant');
  assert.equal(welcomeHidden, 'true');
  assert.equal(cards, '2');
  assert.equal(back, 'false');
  assert.equal(suggested, 'rizzik', 'Horde characters get the goblin suggested');
  assert.equal(chosen, 'rizzik,true');
  assert.equal(afterPick, 'false,true', 'after choosing, the welcome screen appears');
  assert.equal(accent, '0.80', 'Horde red accent for Rizzik');
  assert.match(hello, /negocio/);
  assert.match(pending, /ganancias|letra chica|contactos|transmisor|trato/, 'thinking phrases are Rizzik\'s');
  assert.equal(reopened, 'true,true', 'the chooser can be reopened, now with a way back');
  assert.equal(accent2, '0.25', 'switching to Fizzi recolors the window');
  assert.equal(final, 'fizzi');
});

test('the request tells the app which assistant answers', () => {
  const dump = runLua(`
    UnitFactionGroup = function() return "Alliance" end
    START()
    local d = ASK("¿Qué hago?")
    RESULT = d
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const { req } = decodeDump(dump);
  assert.equal(req.assistant, 'fizzi', 'asking before choosing keeps the faction\'s assistant');
});

test('every texture of the window is anchored (no invisible backgrounds)', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    ns.UI:Refresh()
    ns.Core:Ask("hola")
    RUN_FRAMES(200)
    ns.UI:Refresh()
    ns.UI:ShowCopy("texto")
    ns.Button:Update()
    local missing = {}
    for i, t in ipairs(TEXTURES) do
      if t.parent ~= ns.Uplink.grid and not rawget(t, "anchored") then missing[#missing + 1] = i end
    end
    RESULT = #missing .. "/" .. #TEXTURES
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [missing, total] = out.split('/').map(Number);
  assert.ok(total > 20, `expected many textures, got ${total}`);
  assert.equal(missing, 0, `${missing} textures have no anchor and would be invisible`);
});
test('notification card: preview, click opens the chat, fades away', () => {
  const out = runLua(`
    START()
    local chatA = ns.Chats:Current()
    ns.Core:Ask("¿Qué mazmorra hago?")
    RUN_FRAMES(200)
    ns.UI.frame.shown = false                 -- window closed while waiting
    ns.Chats:New()                            -- and another chat is open
    local id = chatA.messages[1].id
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "Ve a Gnomeregan con tu grupo, es la mejor opción para tu nivel." } } })
    local card = ns.Notify.cards[1]
    local shown = tostring(card.shown)
    local body = card.body.textValue or ""
    local hop = tostring(ns.Button.hopUntil ~= nil)
    local badge = tostring(ns.Button.badge.shown)

    card.scripts.OnClick(card, "LeftButton")
    local opened = tostring(ns.UI.frame.shown) .. "," .. tostring(ns.db.currentChat == chatA.id) .. "," .. tostring(card.shown)

    -- A second answer (error) shows a card that disappears on its own.
    ns.Core:Ask("otra")
    RUN_FRAMES(200)
    local chatB = ns.Chats:Current()
    ns.Chats:New()
    ns.Core:ApplyInbox({ answers = { { id = chatB.messages[#chatB.messages].id, ok = false, answer = "Error: sin conexión" } } })
    local card2 = ns.Notify.cards[1].shown and ns.Notify.cards[1] or ns.Notify.cards[2]
    local before = tostring(card2.shown)
    NOW = NOW + 11
    RUN_FRAMES(2)
    local after = tostring(card2.shown)

    RESULT = table.concat({ shown, hop, badge, opened, before, after }, "#")
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [shown, hop, badge, opened, before, after] = out.split('#');
  assert.equal(shown, 'true', 'a card appears when the answer lands in a chat you are not viewing');
  assert.equal(hop, 'true', 'the floating button hops');
  assert.equal(badge, 'true', 'and shows the unread badge');
  assert.equal(opened, 'true,true,false', 'clicking the card opens that chat and closes the card');
  assert.equal(before, 'true');
  assert.equal(after, 'false', 'cards fade away after a few seconds');
});
test('portraits: race icon atlas when the game has it, icon files or the gadget otherwise', () => {
  const out = runLua(`
    START()
    local P = ns.Personas
    local function fresh(id) local p = P.list[id]; p.resolved = nil; return p end
    -- Modern client: the character creator's race icons exist.
    C_Texture = { GetAtlasInfo = function(name) if name:find("^raceicon128") then return { file = 1 } end end }
    GetFileIDFromPath = function() return nil end
    local a = P.PortraitName(fresh("rizzik")) .. "|" .. P.PortraitName(fresh("fizzi"))
    -- No atlas, but the achievement icon file exists.
    C_Texture = { GetAtlasInfo = function() return nil end }
    GetFileIDFromPath = function(path) if path:find("Goblin_Male") then return 123 end end
    local b = P.PortraitName(fresh("rizzik"))
    -- Nothing at all: the gadget.
    GetFileIDFromPath = function() return nil end
    local c = P.PortraitName(fresh("rizzik"))
    RESULT = a .. "#" .. b .. "#" .. c
  `, {}, ['Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [a, b, c] = out.split('#');
  assert.equal(a, 'atlas raceicon128-goblin-male|atlas raceicon128-gnome-female');
  assert.match(b, /Achievement_Character_Goblin_Male/);
  assert.match(c, /INV_Misc_Coin_01/);
});