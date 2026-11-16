-- Combat: questions can be asked in combat, but the chat window makes sure
-- the player keeps an eye on the game:
--   - in combat, a red bar above the text box: "In combat: keep an eye on the game";
--   - on each hit taken, the window's edge flashes red (the game's own
--     low-health vignette) and the bar says "You're being hit!", with the
--     player's health when the game shares it.
-- Entering and leaving combat (PLAYER_REGEN_*) always works. Hits and health
-- come from UNIT_COMBAT and UNIT_HEALTH; the game may hide combat values from
-- addons (secret values), so every read is guarded and simply skipped then.
local _, ns = ...
local L = ns.L

local Combat = {}
ns.Combat = Combat

Combat.BAR_H = 26
local HIT_HOLD = 4        -- seconds "You're being hit!" stays after the last hit
local FLASH_TIME = 0.9    -- seconds the red edge takes to fade out
local FLASH_GAP = 0.35    -- at most one flash this often
local SWORDS = "Interface\\CharacterFrame\\UI-StateIcon" -- crossed swords (lower right of the sheet)
local VIGNETTE = "Interface\\FullScreenTextures\\LowHealth"
local floor = math.floor

-- A value the addon may use (not hidden from it by the game).
local function plain(v)
  return v ~= nil and not (issecretvalue and issecretvalue(v))
end

function Combat:InCombat()
  local ok, v = pcall(UnitAffectingCombat, "player")
  return ok and plain(v) and v and true or false
end

-- The player's health in percent, or nil when the game doesn't share it.
function Combat:HealthPct()
  local ok, pct = pcall(function()
    local h, m = UnitHealth("player"), UnitHealthMax("player")
    if not plain(h) or not plain(m) or m <= 0 then return nil end
    return floor(h / m * 100 + 0.5)
  end)
  return ok and pct or nil
end

-- The bar and the red edge, inside the chat window (built with it).
function Combat:Build()
  local UI = ns.UI
  if self.bar or not (UI and UI.frame and UI.main) then return end
  local bar = CreateFrame("Frame", nil, UI.main)
  bar:SetPoint("BOTTOMLEFT", 10, 64)
  bar:SetPoint("BOTTOMRIGHT", -10, 64)
  bar:SetHeight(self.BAR_H)
  local bg = bar:CreateTexture(nil, "BACKGROUND")
  bg:SetAllPoints()
  bg:SetColorTexture(0.45, 0.04, 0.04, 0.9)
  local line = bar:CreateTexture(nil, "BORDER")
  line:SetPoint("TOPLEFT")
  line:SetPoint("TOPRIGHT")
  line:SetHeight(1)
  line:SetColorTexture(1, 0.25, 0.2, 0.9)
  local icon = bar:CreateTexture(nil, "ARTWORK")
  icon:SetSize(20, 20)
  icon:SetPoint("LEFT", 6, 0)
  icon:SetTexture(SWORDS)
  icon:SetTexCoord(0.5, 1, 0, 0.49)
  local text = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  text:SetPoint("LEFT", icon, "RIGHT", 6, 0)
  text:SetPoint("RIGHT", -8, 0)
  text:SetJustifyH("LEFT")
  if text.SetWordWrap then text:SetWordWrap(false) end
  bar:Hide()

  -- Over everything in the window (but not catching the mouse).
  local over = CreateFrame("Frame", nil, UI.frame)
  over:SetPoint("TOPLEFT", -10, 10)
  over:SetPoint("BOTTOMRIGHT", 10, -10)
  over:SetFrameLevel((UI.frame:GetFrameLevel() or 1) + 40)
  local glow = over:CreateTexture(nil, "OVERLAY")
  glow:SetAllPoints()
  glow:SetTexture(VIGNETTE)
  if glow.SetBlendMode then glow:SetBlendMode("ADD") end
  glow:SetVertexColor(1, 0.15, 0.1)
  glow:SetAlpha(0)
  over:SetScript("OnUpdate", function(_, elapsed) Combat:Fade(elapsed or 0) end)

  self.bar, self.text, self.icon, self.glow = bar, text, icon, glow
end

-- Shows or hides the bar, says what is going on, and makes room for it.
function Combat:Update()
  self:Build()
  if not self.bar then return end
  local now = GetTime()
  local hit = self.hitAt and now - self.hitAt < HIT_HOLD
  local show = self:InCombat() or hit or false
  if hit then
    local pct = self:HealthPct()
    self.text:SetText("|cffffd0c8" .. (pct and string.format(L.COMBAT_HIT_HEALTH, pct) or L.COMBAT_HIT) .. "|r")
  else
    self.text:SetText(L.COMBAT_ON)
  end
  if show ~= self.bar:IsShown() then
    self.bar:SetShown(show)
    -- The messages end above the bar while it shows.
    local scroll = ns.UI.scroll
    if scroll then
      scroll:SetPoint("BOTTOMRIGHT", -28, 66 + (show and self.BAR_H + 4 or 0))
      if ns.UI.RefreshConversation then pcall(ns.UI.RefreshConversation, ns.UI) end
    end
  end
end

-- A hit taken: flash the edge (not more often than FLASH_GAP).
function Combat:Hit()
  local now = GetTime()
  if self.hitAt and now - self.hitAt < FLASH_GAP then return end
  self.hitAt = now
  self.flash = FLASH_TIME
  self:Update()
end

function Combat:Fade(elapsed)
  if self.flash and self.flash > 0 then
    self.flash = math.max(0, self.flash - elapsed)
    self.glow:SetAlpha(0.9 * self.flash / FLASH_TIME)
  end
  -- "You're being hit!" goes back to "In combat" after a while.
  if self.hitAt and GetTime() - self.hitAt >= HIT_HOLD then
    self.hitAt = nil
    self:Update()
  end
end

function Combat:OnEvent(event, unit, action, _, amount)
  if event == "UNIT_COMBAT" then
    if unit ~= "player" then return end
    if plain(action) and action == "WOUND" and (not plain(amount) or (tonumber(amount) or 0) > 0) then self:Hit() end
    return
  end
  if event == "UNIT_HEALTH" then
    if unit ~= "player" then return end
    -- Health going down (when the game shares it) is a hit too.
    local pct = self:HealthPct()
    if pct and self.lastPct and pct < self.lastPct and self:InCombat() then self:Hit() end
    self.lastPct = pct
    if self.bar and self.bar:IsShown() then self:Update() end
    return
  end
  -- Entering or leaving combat, or a loading screen.
  self.lastPct = self:HealthPct()
  self:Update()
end

local events = CreateFrame and CreateFrame("Frame")
if events then
  for _, e in ipairs({ "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "UNIT_COMBAT", "UNIT_HEALTH", "PLAYER_ENTERING_WORLD" }) do
    pcall(events.RegisterEvent, events, e)
  end
  events:SetScript("OnEvent", function(_, event, ...)
    pcall(Combat.OnEvent, Combat, event, ...)
  end)
end
