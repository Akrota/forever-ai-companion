-- Proactive tips: the assistant speaks up on its own at key moments (an even
-- level, a new zone, a dungeon, a profession milestone, unspent talent points)
-- with a short, actionable tip.
--
-- The switches live in the game (Esc → Options → AddOns → Forever AI
-- Companion) and are saved in ns.db.proactive. Nothing is sent while they
-- say "off". The game detects the moment, builds a question and sends it
-- like any other one (Core:Ask with silent = true): each tip starts its own
-- chat and shows as a notification card.
--
-- Safety rules, so a tip never gets in the way:
--   * each moment is asked once per character (the `seen` keys below);
--   * nothing in combat, dead, on a flight path or on a loading screen: the
--     tip waits in a short queue and goes out when things are quiet;
--   * a cooldown between tips (the app's setting), level-ups first;
--   * never while the player's own question is pending, and only while the
--     app is open and ready (a tip that waited too long is dropped).
local _, ns = ...
local L = ns.L

local Proactive = {}
ns.Proactive = Proactive

local TICK = 2          -- seconds between checks of the queue
local SETTLE = 3        -- seconds after a loading screen before anything is sent
local ZONE_STAY = 20    -- seconds in a new zone before it counts (not just flying through)
local MAX_QUEUE = 3
local EXPIRE = 600      -- a tip that waited this long (seconds) is no longer relevant
local APP_CHECKS = 3    -- app status checks in a row before trusting "ready"
local DEFAULT_COOLDOWN_MIN = 3
local DEFAULT_MAX_LEVEL = 60

local KINDS = { "level", "zone", "dungeon", "profession", "talents" }
-- Lower goes first.
local PRIORITY = { level = 1, dungeon = 2, talents = 3, zone = 4, profession = 5 }
local MILESTONES = { 75, 150, 225, 300 }
-- Skill lines that are professions (the game's names, English, Spanish and German).
local PROFESSIONS = {}
for _, name in ipairs({
  "Alchemy", "Blacksmithing", "Enchanting", "Engineering", "Herbalism", "Leatherworking", "Mining",
  "Skinning", "Tailoring", "Cooking", "First Aid", "Fishing",
  "Alquimia", "Herrería", "Encantamiento", "Ingeniería", "Botánica", "Peletería", "Minería",
  "Desuello", "Sastrería", "Cocina", "Primeros auxilios", "Pesca",
  "Alchemie", "Schmiedekunst", "Verzauberkunst", "Ingenieurskunst", "Kräuterkunde", "Lederverarbeitung", "Bergbau",
  "Kürschnerei", "Schneiderei", "Kochkunst", "Erste Hilfe", "Angeln",
}) do PROFESSIONS[name:lower()] = true end
-- App states in which a tip would go nowhere: the queue is emptied.
local APP_DOWN = { closed = true, stuck = true, restart = true, nosound = true, ["need-ai"] = true, ["need-login"] = true, problem = true }

-- Pure rules ------------------------------------------------------------------

-- Whether reaching `level` deserves a tip: every `every` levels, from level 2
-- on, up to the level cap.
function Proactive.LevelDue(level, every, maxLevel)
  level, every = tonumber(level), tonumber(every) or 2
  if not level or level < 2 or level > (maxLevel or DEFAULT_MAX_LEVEL) then return false end
  return every <= 1 or level % every == 0
end

-- The highest profession milestone (75, 150...) a skill rank has reached.
function Proactive.Milestone(rank)
  local top
  for _, m in ipairs(MILESTONES) do
    if (tonumber(rank) or 0) >= m then top = m end
  end
  return top
end

function Proactive.IsProfession(name)
  return type(name) == "string" and PROFESSIONS[name:lower()] == true
end

-- The app's settings, checked (they come from a file the app writes).
function Proactive.Sanitize(raw)
  if type(raw) ~= "table" then return nil end
  local s = { enabled = raw.enabled == true }
  for _, k in ipairs(KINDS) do s[k] = raw[k] ~= false end
  local cooldown = tonumber(raw.cooldownMin)
  s.cooldownMin = cooldown and math.min(60, math.max(0, cooldown)) or DEFAULT_COOLDOWN_MIN
  local every = tonumber(raw.levelEvery)
  s.levelEvery = (every == 1 or every == 2 or every == 5 or every == 10) and every or 2
  return s
end

-- Settings ---------------------------------------------------------------------

-- Fills ns.db.proactive in place (the options panel holds that table).
function Proactive:EnsureSettings()
  if not ns.db then return nil end
  local current = ns.db.proactive
  local clean = self.Sanitize(type(current) == "table" and current or { enabled = false })
  if type(current) ~= "table" then
    ns.db.proactive = clean
    return clean
  end
  for k, v in pairs(clean) do current[k] = v end
  local extra = {}
  for k in pairs(current) do
    if clean[k] == nil then extra[#extra + 1] = k end
  end
  for _, k in ipairs(extra) do current[k] = nil end
  return current
end

function Proactive:SetSettings(raw)
  if not ns.db then return end
  local clean = self.Sanitize(raw)
  if not clean then return end
  ns.db.proactive = type(ns.db.proactive) == "table" and ns.db.proactive or {}
  local current = ns.db.proactive
  for k in pairs(current) do current[k] = nil end
  for k, v in pairs(clean) do current[k] = v end
end

-- Whether a moment (or any, with nil) may speak: the options say yes and the
-- player has not turned it off in this game (/ia proactive off).
function Proactive:Enabled(kind)
  local s = ns.db and ns.db.proactive
  if not s or not s.enabled or ns.db.proactiveOff then return false end
  return kind == nil or s[kind] == true
end

-- Per character: what was already asked, and the skills known.
function Proactive:Store()
  local data = ns.Core:CharData()
  data.proactive = data.proactive or {}
  data.proactive.seen = data.proactive.seen or {}
  return data.proactive
end

function Proactive:Queued(key)
  for _, item in ipairs(self.queue or {}) do
    if item.key == key then return true end
  end
  return false
end

function Proactive:Enqueue(kind, key, question)
  if not self:Enabled(kind) or self:Store().seen[key] or self:Queued(key) then return false end
  local queue = self.queue
  queue[#queue + 1] = { kind = kind, key = key, question = question, at = GetTime() }
  -- Too many: the oldest tip that is not a level-up goes first.
  while #queue > MAX_QUEUE do
    local victim = 1
    for i, item in ipairs(queue) do
      if item.kind ~= "level" then victim = i break end
    end
    table.remove(queue, victim)
  end
  return true
end

-- Moments ------------------------------------------------------------------------

local function playerLevel()
  return UnitLevel and UnitLevel("player") or 0
end

local function maxLevel()
  return GetMaxPlayerLevel and GetMaxPlayerLevel() or DEFAULT_MAX_LEVEL
end

local function zoneName()
  local name = (GetRealZoneText and GetRealZoneText()) or (GetZoneText and GetZoneText())
  return name ~= "" and name or nil
end

function Proactive:OnLevelUp(level)
  level = tonumber(level) or playerLevel()
  local s = ns.db.proactive
  if not self:Enabled("level") or not self.LevelDue(level, s.levelEvery, maxLevel()) then return end
  self:Enqueue("level", "level:" .. level, string.format(L.PROACTIVE_Q_LEVEL, level))
end

-- A new zone that suits the character's level, once they stay in it.
function Proactive:CheckZone()
  if not self:Enabled("zone") then return end
  local name = zoneName()
  if not name or (IsInInstance and IsInInstance()) then return end
  local key = "zone:" .. name
  if self:Store().seen[key] or self:Queued(key) or self.verifying[key] then return end
  if not ns.ZoneLevels:Suits(name, playerLevel()) then return end
  self.verifying[key] = true
  C_Timer.After(ZONE_STAY, function()
    Proactive.verifying[key] = nil
    if zoneName() == name and not (UnitOnTaxi and UnitOnTaxi("player")) then
      Proactive:Enqueue("zone", key, string.format(L.PROACTIVE_Q_ZONE, name, playerLevel()))
    end
  end)
end

function Proactive:CheckInstance()
  local inInstance, kind = false, nil
  if IsInInstance then inInstance, kind = IsInInstance() end
  if not inInstance or (kind ~= "party" and kind ~= "raid") or not self:Enabled("dungeon") then return end
  local name = (GetInstanceInfo and (GetInstanceInfo())) or zoneName()
  if not name or name == "" then return end
  self:Enqueue("dungeon", "dungeon:" .. name, string.format(L.PROACTIVE_Q_DUNGEON, name, playerLevel()))
end

local function unspentPoints()
  local readers = {}
  if GetUnspentTalentPoints then readers[#readers + 1] = function() return GetUnspentTalentPoints() end end
  if UnitCharacterPoints then readers[#readers + 1] = function() return UnitCharacterPoints("player") end end
  for _, read in ipairs(readers) do
    local ok, n = pcall(read)
    if ok and tonumber(n) then return tonumber(n) end
  end
  return 0
end

-- A talent point was gained (the event's change is positive).
function Proactive:OnPointsChanged(change)
  if (tonumber(change) or 0) <= 0 or not self:Enabled("talents") then return end
  C_Timer.After(1, function()
    local points, level = unspentPoints(), playerLevel()
    if points > 0 then
      Proactive:Enqueue("talents", "talents:" .. level, string.format(L.PROACTIVE_Q_TALENTS, points, level))
    end
  end)
end

-- name -> rank of the character's professions.
local function readProfessions()
  local count = (C_SkillInfo and C_SkillInfo.GetNumSkillLines) or GetNumSkillLines
  local info = (C_SkillInfo and C_SkillInfo.GetSkillLineInfo) or GetSkillLineInfo
  if not (count and info) then return nil end
  local out, any = {}, false
  for i = 1, tonumber(count()) or 0 do
    local r = { info(i) }
    local name, isHeader, rank
    if type(r[1]) == "table" then
      local t = r[1]
      name, isHeader = t.skillName or t.name or t.skillLineName, t.isHeader
      rank = t.skillRank or t.rank or t.skillLineRank
    else
      name, isHeader, rank = r[1], r[2], r[4]
    end
    if not isHeader and name then
      any = true
      if Proactive.IsProfession(name) and (tonumber(rank) or 0) > 0 then out[name] = tonumber(rank) end
    end
  end
  return any and out or nil
end

-- A profession crossed a milestone, or a new one was learned. The first scan
-- of a character only takes note of what it already has.
function Proactive:ScanSkills()
  if not self:Enabled("profession") then return end
  local skills = readProfessions()
  if not skills then return end
  local store = self:Store()
  local first = store.known == nil
  store.known = store.known or {}
  for name, rank in pairs(skills) do
    local top = self.Milestone(rank)
    if first or store.known[name] then
      -- Lower milestones are skipped: only the one reached now is worth a tip.
      for _, m in ipairs(MILESTONES) do
        local key = "profession:" .. name .. ":" .. m
        if top and m <= top and not store.seen[key] then
          -- Skills are read again on every skill-up, so a milestone is noted
          -- as soon as it is queued: a tip that expires is not asked later.
          if first or m < top or self:Enqueue("profession", key, string.format(L.PROACTIVE_Q_PROFESSION, name, rank)) then
            store.seen[key] = true
          end
        end
      end
    else
      local key = "profession:" .. name .. ":new"
      if self:Enqueue("profession", key, string.format(L.PROACTIVE_Q_PROFESSION_NEW, name)) then store.seen[key] = true end
    end
    store.known[name] = true
  end
end

-- Sending -------------------------------------------------------------------------

-- Nothing is sent in combat, while dead, flying, loading or typing a question.
function Proactive:Quiet()
  if self.loading or GetTime() < (self.readyAt or 0) then return false end
  if InCombatLockdown and InCombatLockdown() then return false end
  if UnitAffectingCombat and UnitAffectingCombat("player") then return false end
  if UnitIsDeadOrGhost and UnitIsDeadOrGhost("player") then return false end
  if UnitOnTaxi and UnitOnTaxi("player") then return false end
  if ns.Core.working or ns.Uplink.busy or ns.Core:HasPending() then return false end
  return ns.Personas:Chosen() and true or false
end

-- Whether the app is open and ready, from a few checks in a row (the app's
-- status is only watched while the window is open, see Live:CheckApp). Returns
-- true / false, and nil when the answer is not known yet.
function Proactive:AppReady()
  local live = ns.Live
  if not live then return false end
  live:CheckApp()
  self.appChecks = (self.appChecks or 0) + 1
  if self.appChecks < APP_CHECKS then return nil end
  local state = live:AppState()
  if state == "ready" or state == "unknown" then return true end
  if APP_DOWN[state] then return false end
  return nil
end

function Proactive:Tick()
  local queue = self.queue
  local now = GetTime()
  for i = #queue, 1, -1 do
    if now - queue[i].at > EXPIRE or not self:Enabled(queue[i].kind) then table.remove(queue, i) end
  end
  local cooldown = (ns.db.proactive and ns.db.proactive.cooldownMin or DEFAULT_COOLDOWN_MIN) * 60
  if #queue == 0 or (self.lastSent and now - self.lastSent < cooldown) or not self:Quiet() then
    self.appChecks = 0
    return
  end
  -- The best tip for this moment: level-ups first; in an instance only the
  -- dungeon's own tip.
  local inInstance = IsInInstance and IsInInstance()
  local best
  for _, item in ipairs(queue) do
    if (item.kind == "dungeon" or not inInstance)
      and (not best or PRIORITY[item.kind] < PRIORITY[best.kind]) then
      best = item
    end
  end
  if not best then return end
  local ready = self:AppReady()
  if ready == false then
    self.queue = {} -- the app is not there: these would only be stale later
    return
  end
  if not ready then return end
  local id = ns.Core:Ask(best.question, { proactive = { kind = best.kind, key = best.key } }, nil, nil, { silent = true })
  if not id then return end
  for i, item in ipairs(queue) do
    if item == best then table.remove(queue, i) break end
  end
  self:Store().seen[best.key] = true
  self.lastSent = now
  self.appChecks = 0
end

-- Events ----------------------------------------------------------------------------

local EVENTS = {
  "PLAYER_LEAVING_WORLD", "PLAYER_ENTERING_WORLD", "ZONE_CHANGED_NEW_AREA", "PLAYER_LEVEL_UP",
  "SKILL_LINES_CHANGED", "CHARACTER_POINTS_CHANGED",
}

function Proactive:OnEvent(event, arg1)
  if event == "PLAYER_LEAVING_WORLD" then
    self.loading = true
    return
  end
  if event == "PLAYER_ENTERING_WORLD" then
    self.loading = false
    self.readyAt = GetTime() + SETTLE
    -- A brand-new character starts in a zone it never "entered".
    if playerLevel() <= 1 then self:CheckZone() end
    C_Timer.After(2, function() Proactive:CheckInstance() end)
    -- Skills are read once the login rush is over.
    self:ScanSkillsSoon()
  elseif event == "ZONE_CHANGED_NEW_AREA" then
    self:CheckZone()
    C_Timer.After(2, function() Proactive:CheckInstance() end)
  elseif event == "PLAYER_LEVEL_UP" then
    self:OnLevelUp(arg1)
  elseif event == "SKILL_LINES_CHANGED" then
    self:ScanSkillsSoon()
  elseif event == "CHARACTER_POINTS_CHANGED" then
    self:OnPointsChanged(arg1)
  end
end

-- Skill events come in bursts: read once it settles.
function Proactive:ScanSkillsSoon()
  if self.scanPending then return end
  self.scanPending = true
  C_Timer.After(2, function()
    Proactive.scanPending = nil
    pcall(Proactive.ScanSkills, Proactive)
  end)
end

function Proactive:Init()
  if self.frame then return end
  self.queue, self.verifying = {}, {}
  self.readyAt = GetTime() + SETTLE
  self.frame = CreateFrame("Frame")
  for _, e in ipairs(EVENTS) do pcall(self.frame.RegisterEvent, self.frame, e) end
  self.frame:SetScript("OnEvent", function(_, event, arg1)
    if ns.db then pcall(Proactive.OnEvent, Proactive, event, arg1) end
  end)
  C_Timer.NewTicker(TICK, function() pcall(Proactive.Tick, Proactive) end)
  self:EnsureSettings()
  -- A game session that starts without having asked anything still reads the
  -- inbox once, so an answer that arrived while the game was closed shows up.
  C_Timer.After(10, function()
    if ns.Live and not ns.Live.usedSlots then pcall(ns.Live.LoadNextSlot, ns.Live) end
  end)
end

-- /ia proactive [on|off]: what is going on, or a switch just for this game.
function Proactive:Command(arg)
  if arg == "off" then
    ns.db.proactiveOff = true
    self.queue = {}
    return L.PROACTIVE_NOW_OFF
  elseif arg == "on" then
    ns.db.proactiveOff = nil
    return L.PROACTIVE_NOW_ON
  end
  local s = ns.db.proactive
  local state = ns.db.proactiveOff and L.PROACTIVE_PAUSED
    or (s and (s.enabled and L.PROACTIVE_ON or L.PROACTIVE_OFF))
    or L.PROACTIVE_NO_SETTINGS
  local text = string.format(L.PROACTIVE_STATUS, state, #(self.queue or {}))
  if s and s.enabled then
    local on = {}
    for _, k in ipairs(KINDS) do
      if s[k] then on[#on + 1] = L["KIND_" .. k:upper()] end
    end
    text = text .. " " .. string.format(L.PROACTIVE_STATUS_KINDS, #on > 0 and table.concat(on, ", ") or "-")
  end
  return text
end
