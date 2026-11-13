-- /ia probar-canales: tries every "invisible" way the game might have to hand
-- data to the companion app, and lets the app measure which ones work here.
--
-- Each probe writes a marker "AZIA-PROBE-<token>" somewhere the WoW client
-- may save to disk (a custom CVar, a macro, the addon list, the chat log) and
-- reports what the text-to-speech API offers. The companion app watches those
-- files; after WAIT seconds the addon undoes its changes and sends the results
-- through the normal channel, and the app answers with the verdict.
local _, ns = ...

local Probe = {}
ns.Probe = Probe

local WAIT = 25
local MACRO = "AZIAPROBE"
local SLOT = "AzerothIA_S50"
local PREFIX = "AZIAPROBE"

local function try(fn, ...)
  if type(fn) ~= "function" then return false, "no existe" end
  local ok, err = pcall(fn, ...)
  if ok then return true end
  return false, tostring(err):gsub("^.-:%d+: ", ""):sub(1, 80)
end

local function api(path)
  local v = _G
  for part in path:gmatch("[^%.]+") do
    v = type(v) == "table" and v[part] or nil
  end
  return v
end

local function enableAddOn(name, on)
  local fn = on and (api("C_AddOns.EnableAddOn") or EnableAddOn) or (api("C_AddOns.DisableAddOn") or DisableAddOn)
  local ok, err = try(fn, name, UnitName("player"))
  if not ok then ok, err = try(fn, name) end
  local save = api("C_AddOns.SaveAddOns") or SaveAddOns
  local saved, serr = try(save)
  return ok and saved, err or serr
end

function Probe:Run()
  if self.running then
    ns.UI:SetStatus("La prueba de canales ya está en marcha.")
    return
  end
  if InCombatLockdown() or UnitAffectingCombat("player") then
    ns.UI:SetStatus("|cffff6060Sal del combate para hacer la prueba.|r")
    return
  end
  self.running = true
  ns.UI:Show()
  ns.UI:SetStatus(string.format("Probando canales invisibles (%d s)...", WAIT))

  local token = tostring(time()) .. tostring(math.random(1000, 9999))
  local marker = "AZIA-PROBE-" .. token
  local r = { token = token, actions = {}, results = {} }
  local function did(name, ok, err)
    r.actions[name] = time()
    r.results[name] = ok and "ok" or (err or "falló")
  end

  -- 1. Custom CVar (Config.wtf).
  try(RegisterCVar, "aziaProbe", "")
  local setCVar = api("C_CVar.SetCVar") or SetCVar
  did("cvar", try(setCVar, "aziaProbe", marker))

  -- 2. Addon list (AddOns.txt): disable the last mailbox and save.
  did("addons", enableAddOn(SLOT, false))

  -- 3. A macro (macros-cache.txt).
  local body = "-- " .. marker
  local index = GetMacroIndexByName and GetMacroIndexByName(MACRO) or 0
  if index and index > 0 then
    did("macro", try(EditMacro, index, MACRO, nil, body))
  else
    did("macro", try(CreateMacro, MACRO, "INV_MISC_QUESTIONMARK", body, false))
  end

  -- 4. Chat log: an addon message whispered to ourselves, with logging on.
  if LoggingChat then
    r.chatLoggingBefore = LoggingChat() and true or false
    try(LoggingChat, true)
  end
  local register = api("C_ChatInfo.RegisterAddonMessagePrefix") or RegisterAddonMessagePrefix
  local send = api("C_ChatInfo.SendAddonMessage") or SendAddonMessage
  try(register, PREFIX)
  did("chat", try(send, PREFIX, marker, "WHISPER", UnitName("player")))

  -- 5. Text to speech: which voices the game offers, and whether it speaks.
  local voices = {}
  local getVoices = api("C_VoiceChat.GetTtsVoices")
  if getVoices then
    local ok, list = pcall(getVoices)
    for _, v in ipairs(ok and list or {}) do
      voices[#voices + 1] = { id = v.voiceID, name = v.name }
    end
  end
  r.ttsVoices = voices
  local speak = api("C_VoiceChat.SpeakText")
  if speak and voices[1] then
    -- Volume 0: nothing is heard. Two known signatures across game versions.
    local ok, err = try(speak, voices[1].id, "AzerothIA", 0, 0, false)
    if not ok then ok, err = try(speak, voices[1].id, "AzerothIA", 1, 0, 0) end
    did("tts", ok, err)
  else
    did("tts", false, speak and "sin voces" or "no existe")
  end

  -- 6. Taskbar icon flash (a 1-bit signal).
  r.flashClientIcon = FlashClientIcon and true or false

  C_Timer.After(WAIT, function()
    -- Undo everything.
    enableAddOn(SLOT, true)
    local idx = GetMacroIndexByName and GetMacroIndexByName(MACRO) or 0
    if idx and idx > 0 then try(DeleteMacro, idx) end
    try(setCVar, "aziaProbe", "")
    if LoggingChat and r.chatLoggingBefore ~= nil then try(LoggingChat, r.chatLoggingBefore) end
    Probe.running = false
    ns.Core:Ask("Prueba de canales invisibles", { probe = r })
  end)
end
