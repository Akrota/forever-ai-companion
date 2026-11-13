local ADDON, ns = ...

local Core = {}
ns.Core = Core

local HISTORY_TURNS_SENT = 6      -- earlier Q&A of the same chat sent along
local HISTORY_ANSWER_CHARS = 600
local PENDING_TIMEOUT = 150       -- seconds

local function chat(msg)
  print("|cff66ccffForever AI:|r " .. msg)
end

function Core:FindEntry(id)
  return ns.Chats:FindEntry(id)
end

-- A question sent through the invisible voice with no answer after this
-- long is re-sent through the strip, and the voice is skipped this session.
local VOICE_TIMEOUT = 45

function Core:HasPending()
  local now = time()
  local any = false
  local resend
  ns.Chats:EachEntry(function(e, c)
    if e.status == "pending" and e.viaVoice and now - (e.t or now) > VOICE_TIMEOUT and not self.working then
      e.status = "error"
      e.answer = "El envío invisible no llegó a la app; lo reenvié con la línea en pantalla."
      ns.Voice.broken = true
      resend = { question = e.question, chatId = c.id }
      ns.UI:Refresh()
    elseif e.status == "pending" then
      if now - (e.t or now) > PENDING_TIMEOUT then
        e.status = "error"
        e.answer = "No llegó respuesta. ¿Está abierta la app compañera en tu PC?"
        ns.UI:Refresh()
      else
        any = true
      end
    end
  end)
  if resend then
    C_Timer.After(0, function() Core:Ask(resend.question, nil, resend.chatId) end)
    any = true
  end
  return any
end

-- Earlier answered turns of a chat (before the question being asked now).
function Core:RecentTurns(chatData, n)
  local turns = {}
  local messages = chatData and chatData.messages or {}
  for i = #messages, 1, -1 do
    local e = messages[i]
    if e.status == "done" then
      table.insert(turns, 1, { q = e.question, a = (e.answer or ""):sub(1, HISTORY_ANSWER_CHARS) })
      if #turns >= n then break end
    end
  end
  return turns
end

-- Sections that change on almost every question are always sent in full.
local ALWAYS_SEND = { localTime = true, serverTime = true, diagnostics = true }

-- Work allowed per frame while preparing a question, in milliseconds.
-- Spreading the work over several frames is what keeps the game from stuttering.
Core.BUDGET_MS = 4

local floor = math.floor
local function now()
  return debugprofilestop and debugprofilestop() or GetTime() * 1000
end

-- Pauses the preparation until the next frame once this frame's budget is used.
-- Only valid inside the preparation coroutine.
function Core.step()
  if now() > (Core.deadline or 0) then coroutine.yield() end
end

-- Copies of a list of tables without some keys (cached data is never modified).
local function without(list, keys, keep)
  if type(list) ~= "table" then return list end
  local out = {}
  for _, item in ipairs(list) do
    if type(item) == "table" then
      if not keep or keep(item) then
        local copy = {}
        for k, v in pairs(item) do copy[k] = v end
        for _, k in ipairs(keys) do copy[k] = nil end
        out[#out + 1] = copy
      end
    else
      out[#out + 1] = item
    end
  end
  return out
end

-- Successive reductions if a request does not fit. Each one replaces whole
-- sections with smaller copies.
local TRIMS = {
  function(ctx) ctx.bank = nil end,
  function(ctx, req) req.history = nil end,
  function(ctx) ctx.quests = without(ctx.quests, { "rewardItems", "rewardChoices" }) end,
  function(ctx)
    ctx.inventory = without(ctx.inventory, { "stats" }, function(it) return it.quality ~= "poor" end)
  end,
  function(ctx) ctx.spells, ctx.currencies, ctx.reputations = nil, nil, nil end,
  function(ctx) ctx.quests = without(ctx.quests, { "goal", "nextStep" }) end,
  function(ctx)
    ctx.gear = without(ctx.gear, { "stats" })
    ctx.quests = without(ctx.quests, { "objectives" })
  end,
  function(ctx) ctx.quests, ctx.professions, ctx.inventory = nil, nil, nil end,
}

-- Request JSON from sections that are (mostly) already encoded.
local function assemble(req, ctx, encoded, step)
  local keys = {}
  for k in pairs(ctx) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do
    parts[#parts + 1] = '"' .. k .. '":' .. (encoded[k] or ns.Json.Encode(ctx[k]))
    step()
  end
  local head = ns.Json.Encode(req) -- everything except the context
  return head:sub(1, -2) .. ',"context":{' .. table.concat(parts, ",") .. "}}"
end

-- Gathers the character data and turns it into the bytes to draw.
-- Only what changed is sent: sections whose hash the companion already
-- confirmed (it answered a request that carried them) go as { name = hash }
-- in `same`, and the companion fills them in from its cache.
-- maxBytes: size limit for channels without the screen's limits (voice).
function Core:BuildFrame(req, step, maxBytes)
  local fits = maxBytes and function(len) return len <= maxBytes end
    or function(len) return ns.Uplink:Fits(len) end
  local t0 = now()
  local snap, meta, errors = ns.Collect:Gather(step)
  local t1 = now()
  local acked = self:CharData().acked or {}
  local ctx, encoded, hashes, same = {}, {}, {}, {}
  for k, v in pairs(snap) do
    local m = meta[k]
    if m and not ALWAYS_SEND[k] and acked[k] == m.hash then
      same[k] = m.hash
    else
      ctx[k] = v
      if m then encoded[k], hashes[k] = m.json, m.hash end
    end
  end
  if next(errors) then ctx.diagnostics = errors end
  req.hashes, req.same = hashes, same

  local frame, json
  for level = 0, #TRIMS do
    if level > 0 then
      local before = {}
      for k, v in pairs(ctx) do before[k] = v end
      TRIMS[level](ctx, req)
      -- Trimmed sections are re-encoded and not cached by the companion.
      for k, v in pairs(before) do
        if ctx[k] ~= v then encoded[k], hashes[k] = nil, nil end
      end
    end
    json = assemble(req, ctx, encoded, step)
    frame = ns.Uplink.Frame(json, step)
    if fits(#frame) then
      self.lastEncode = {
        level = level, bytes = #frame, json = #json,
        collectMs = floor(t1 - t0), encodeMs = floor(now() - t1),
      }
      return frame
    end
    step()
  end
  self.lastEncode = { failed = string.format("%d bytes (JSON %d) incluso recortando todo", #frame, #json) }
  return nil, self.lastEncode.failed
end


-- Per-character data remembered between sessions.
function Core:CharData()
  if not ns.db then return nil end
  local key = (UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?")
  ns.db.chars = ns.db.chars or {}
  ns.db.chars[key] = ns.db.chars[key] or {}
  return ns.db.chars[key]
end

function Core:RememberBank()
  local items = ns.Collect.ContainerItems(ns.Collect.BankBags(), false)
  if items and #items > 0 then
    self:CharData().bank = { seenAt = date("%Y-%m-%d %H:%M"), items = items }
  end
end

function Core:RememberFlightPaths()
  local data = self:CharData()
  data.flightPaths = data.flightPaths or {}
  if C_TaxiMap and C_TaxiMap.GetAllTaxiNodes then
    local mapID = (GetTaxiMapID and GetTaxiMapID()) or (C_Map and C_Map.GetBestMapForUnit("player"))
    local unreachable = Enum and Enum.FlightPathState and Enum.FlightPathState.Unreachable
    for _, node in ipairs(C_TaxiMap.GetAllTaxiNodes(mapID) or {}) do
      if node.name and node.state ~= unreachable then data.flightPaths[node.name] = true end
    end
  elseif NumTaxiNodes and TaxiNodeName then
    for i = 1, NumTaxiNodes() do
      if TaxiNodeGetType(i) ~= "NONE" then data.flightPaths[TaxiNodeName(i)] = true end
    end
  end
end

function Core:RememberTurnIn(questID)
  local title = C_QuestLog and C_QuestLog.GetTitleForQuestID and C_QuestLog.GetTitleForQuestID(questID)
  if not title then return end
  local data = self:CharData()
  data.turnedIn = data.turnedIn or {}
  table.insert(data.turnedIn, 1, title)
  while #data.turnedIn > 10 do table.remove(data.turnedIn) end
end

-- `extra`: additional request fields (used by the channel probe).
-- `chatId`: chat the question belongs to (default: the open one).
function Core:Ask(question, extra, chatId)
  question = strtrim(question or "")
  if question == "" then return end
  ns.UI:Show()
  if InCombatLockdown() or UnitAffectingCombat("player") then
    ns.UI:SetStatus("|cffff6060No puedo preguntar durante el combate.|r")
    return
  end
  if self.working or ns.Uplink.busy then
    ns.UI:SetStatus("Espera un momento: todavía estoy enviando la pregunta anterior.")
    return
  end

  -- Asking before choosing an assistant: keep the one of the character's faction.
  if not ns.Personas:Chosen() then ns.Personas:Set(ns.Personas:Suggested().id) end
  ns.UI.choosing = false

  -- The question belongs to the open chat (or to the given one, for resends).
  local chatData = ns.Chats:Get(chatId) or ns.Chats:Current()
  local id = string.format("%d%04d", time(), math.random(0, 9999))
  local sig, resetSignals = ns.Live:RequestFields()
  local req = {
    v = 2,
    id = id,
    question = question,
    sig = sig,
    resetSignals = resetSignals,
    charKey = (UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?"),
    assistant = ns.Personas:Current().id,
    history = self:RecentTurns(chatData, HISTORY_TURNS_SENT),
  }
  for k, v in pairs(extra or {}) do req[k] = v end

  local entry = { id = id, question = question, status = "pending", t = time() }
  ns.Chats:AddMessage(chatData, entry)
  req.chat = { id = chatData.id, title = chatData.title }

  local function fail(msg)
    Core.working = false
    entry.status = "error"
    entry.answer = msg
    ns.UI:SetStatus("")
    ns.UI:Refresh()
  end

  ns.UI:Refresh()
  ns.UI:SetStatus("Preparando...")
  self.working = true

  -- The preparation runs a few milliseconds per frame (see Core.step).
  -- Invisible voice channel when available; otherwise the strip on screen.
  local co = coroutine.create(function()
    if ns.Voice:Available() then
      local frame = Core:BuildFrame(req, Core.step, ns.Voice.MAX_FRAME_BYTES)
      if frame and ns.Voice:Send(frame, req.id, Core.step) then
        Core.lastChannel = "voz"
        return true, "voice"
      end
    end
    Core.lastChannel = "franja"
    local frame, why = Core:BuildFrame(req, Core.step)
    if not frame then return false, why end
    return ns.Uplink:Prepare(frame, Core.step)
  end)
  self.driver = self.driver or CreateFrame("Frame")
  local frames = 0
  self.driver:SetScript("OnUpdate", function(f)
    frames = frames + 1
    Core.deadline = now() + Core.BUDGET_MS
    local resumed, ok, err = coroutine.resume(co)
    if coroutine.status(co) ~= "dead" then return end
    f:SetScript("OnUpdate", nil)
    if not resumed then
      fail("Error preparando la pregunta: " .. tostring(ok))
      return
    end
    if not ok then
      fail("No se pudo preparar la pregunta (" .. tostring(err) .. "). Escribe /ia estado y comparte lo que aparece.")
      return
    end
    if Core.lastEncode then Core.lastEncode.frames = frames end
    entry.sent = req.hashes
    if err == "voice" then
      entry.viaVoice = true
      Core.working = false
      ns.UI:SetStatus("Pregunta enviada a " .. ns.Personas:Current().name .. ".")
      ns.Live:OnSent()
      return
    end
    ns.UI:SetStatus(string.format("Enviando (%.1f KB)...", ns.Uplink.last.bytes / 1024))
    ns.Uplink:Reveal(function()
      Core.working = false
      ns.UI:SetStatus("Pregunta enviada a " .. ns.Personas:Current().name .. ".")
      ns.Live:OnSent()
    end)
  end)
end


function Core:ApplyInbox(inbox)
  if type(inbox) ~= "table" or type(inbox.answers) ~= "table" then return end
  local arrived = 0
  local toNotify = {}
  local data = self:CharData()
  for _, a in ipairs(inbox.answers) do
    local entry, owner
    if type(a) == "table" then entry, owner = self:FindEntry(a.id) end
    if entry and entry.status == "pending" then
      entry.status = a.ok and "done" or "error"
      entry.answer = a.answer
      arrived = arrived + 1
      -- Chats with news the player is not looking at: mark and notify.
      owner.updated = time()
      if owner.id ~= ns.db.currentChat or not ns.UI:IsShown() then
        owner.unread = true
        toNotify[#toNotify + 1] = { entry = entry, chat = owner }
      end
      -- The companion has now cached these sections: next time, skip them.
      data.acked = data.acked or {}
      for k, h in pairs(entry.sent or {}) do data.acked[k] = h end
      entry.sent = nil
    end
  end
  -- The companion lost its cache: send everything next time.
  if inbox.resync and tonumber(inbox.resync) and tonumber(inbox.resync) > (data.resyncSeen or 0) then
    data.resyncSeen = tonumber(inbox.resync)
    data.acked = nil
  end
  -- The companion saw our screenshot but could not read it: fail the
  -- questions sent shortly before that instead of waiting forever.
  local failedAt = tonumber(inbox.failedAt)
  if failedAt then
    ns.Chats:EachEntry(function(e)
      if e.status == "pending" and e.t and e.t <= failedAt and e.t >= failedAt - 300 then
        e.status = "error"
        e.answer = (inbox.failMessage or "No se pudo leer la pregunta.") .. " Vuelve a intentarlo."
        arrived = arrived + 1
      end
    end)
  end
  if arrived > 0 then
    ns.Live:OnAnswer()
    ns.UI:SetStatus("")
    ns.UI:Refresh()
    if ns.Button then ns.Button:Update() end
    if #toNotify > 0 and ns.Notify then
      for _, n in ipairs(toNotify) do ns.Notify:Show(n.entry, n.chat) end
    elseif ns.Button and ns.Button.Celebrate then
      ns.Button:Celebrate() -- answer in the open chat: no card, just the hop
    end
  end
end

-- Events ------------------------------------------------------------------

local events = CreateFrame("Frame")
for _, e in ipairs({ "ADDON_LOADED", "PLAYER_LOGIN", "BANKFRAME_OPENED", "BANKFRAME_CLOSED",
                     "PLAYERBANKSLOTS_CHANGED", "TAXIMAP_OPENED", "QUEST_TURNED_IN" }) do
  pcall(events.RegisterEvent, events, e)
end
events:SetScript("OnEvent", function(_, event, arg1)
  if event == "ADDON_LOADED" and arg1 == ADDON then
    AzerothIA_DB = AzerothIA_DB or {}
    ns.db = AzerothIA_DB
    ns.Chats:Init()
  elseif event == "PLAYER_LOGIN" then
    ns.Uplink:Init()
    ns.Live:Init()
    if ns.Button then pcall(ns.Button.Init, ns.Button) end
    -- Build the strip's textures in the background once the login rush is over.
    C_Timer.After(5, function() pcall(ns.Uplink.Warmup, ns.Uplink) end)
  elseif not ns.db then
    return
  elseif event == "BANKFRAME_OPENED" or event == "BANKFRAME_CLOSED" or event == "PLAYERBANKSLOTS_CHANGED" then
    -- Bank contents are only readable while it is open: remember them.
    if event ~= "BANKFRAME_CLOSED" or not Core.bankSaved then pcall(Core.RememberBank, Core) end
    Core.bankSaved = event ~= "BANKFRAME_CLOSED" and true or nil
  elseif event == "TAXIMAP_OPENED" then
    pcall(Core.RememberFlightPaths, Core)
  elseif event == "QUEST_TURNED_IN" then
    pcall(Core.RememberTurnIn, Core, arg1)
  end
end)

-- Slash commands -------------------------------------------------------------

SLASH_AZEROTHIA1 = "/ia"
SLASH_AZEROTHIA2 = "/azia"
SlashCmdList.AZEROTHIA = function(msg)
  msg = strtrim(msg or "")
  local cmd = msg:lower()
  if cmd == "" then
    ns.UI:Toggle()
  elseif cmd == "datos" then
    ns.UI:ShowContext()
  elseif cmd == "buzon" or cmd == "buzón" then
    ns.Live:LoadNextSlot()
  elseif cmd == "estado" then
    chat(ns.Live:Status())
  elseif cmd == "probar-canales" or cmd == "probar" then
    ns.Probe:Run()
  elseif cmd == "probar-voz" then
    ns.Voice:Diagnose()
  elseif cmd == "boton" or cmd == "botón" then
    ns.Button:Toggle()
  elseif cmd == "boton reset" or cmd == "botón reset" then
    ns.Button:Reset()
    chat("botón devuelto a su posición inicial.")
  elseif cmd == "sonido" then
    chat(ns.Notify:ToggleSound() and "sonido de notificación activado." or "sonido de notificación desactivado.")
  elseif cmd == "nuevo" then
    ns.Chats:New()
    ns.UI:Show()
    ns.UI:Refresh()
  elseif cmd == "asistente" then
    ns.UI:ShowChooser()
  elseif cmd == "asistente fizzi" or cmd == "asistente rizzik" then
    ns.Personas:Set(cmd:match("%a+$"))
    chat(ns.Personas:Current().name .. " es ahora tu asistente.")
  elseif cmd == "ayuda" then
    chat("/ia abre la ventana · /ia <pregunta> pregunta en el chat abierto · /ia nuevo crea un chat · /ia asistente elige entre Fizzi y Rizzik · /ia boton muestra u oculta el botón flotante (/ia boton reset lo recoloca) · /ia sonido activa o silencia el aviso · /ia datos muestra lo que se envía · /ia estado · /ia buzon revisa respuestas")
  else
    Core:Ask(msg)
  end
end

function AzerothIA_Toggle()
  ns.UI:Toggle()
end
