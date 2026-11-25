-- Proactive tips in the game's own settings: Esc → Options → AddOns →
-- Forever AI Companion. The switches live in the addon's saved variables
-- (ns.db.proactive). The companion app answers whatever the game sends.
--
-- The native settings checkbox is 280px wide and does not wrap, so a sentence
-- like "Let the assistant speak up on its own" is cut off. This page draws its
-- own rows, as wide as the options panel, and wraps the label.
local ADDON, ns = ...
local L = ns.L

local LEVEL_STEPS = { 1, 2, 5, 10 }
local COOLDOWNS = { 1, 3, 5, 10, 15, 30 }
local PAD = 16
local CHECK = 26
local GAP = 8

local function tableRef()
  ns.Proactive:EnsureSettings()
  return ns.db.proactive
end

local function everyLabel(n)
  return n == 1 and L.OPT_PRO_EVERY_1 or string.format(L.OPT_PRO_EVERY_N, n)
end

local function minutesLabel(n)
  return string.format(L.OPT_PRO_MINUTES, n)
end

local function textHeight(fs, width)
  fs:SetWidth(width)
  local h = fs:GetStringHeight()
  if h and h > 1 then return h end
  local sw = fs:GetStringWidth()
  local lines = math.max(1, math.ceil((sw and sw > 0 and sw or width) / width))
  return lines * 16
end

local function paint(fs, enabled)
  fs:SetFontObject(enabled and "GameFontNormal" or "GameFontDisable")
end

-- A checkbox whose label uses the whole row and wraps onto the next line.
local function addCheck(panel, rows, key, label, tip, indent, needs)
  local cb = CreateFrame("CheckButton", nil, panel, "UICheckButtonTemplate")
  cb:SetSize(CHECK, CHECK)
  local builtin = cb.Text
  if not builtin and cb.GetName and cb:GetName() then builtin = _G[cb:GetName() .. "Text"] end
  if builtin then builtin:SetText("") builtin:Hide() end

  local text = panel:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  text:SetJustifyH("LEFT")
  text:SetJustifyV("TOP")
  text:SetWordWrap(true)
  text:SetText(label)

  local hit = CreateFrame("Button", nil, panel)
  hit:SetScript("OnClick", function()
    if cb:IsEnabled() then cb:Click() end
  end)

  local function showTip(owner)
    if not GameTooltip then return end
    GameTooltip:SetOwner(owner, "ANCHOR_RIGHT")
    GameTooltip:SetText(label, 1, 1, 1, 1, true)
    GameTooltip:AddLine(tip, 1, 0.82, 0, true)
    GameTooltip:Show()
  end
  cb:SetScript("OnEnter", function(self) showTip(self) end)
  cb:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  hit:SetScript("OnEnter", function(self) showTip(self) end)
  hit:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  cb:SetScript("OnClick", function(self)
    tableRef()[key] = self:GetChecked() and true or false
    if panel.Refresh then panel:Refresh() end
  end)

  rows[#rows + 1] = { kind = "check", cb = cb, text = text, hit = hit, key = key, indent = indent or 0, needs = needs }
end

-- A short label plus a button that cycles the setting. The label wraps too.
local function addChoice(panel, rows, key, caption, values, labelFor, indent, needs)
  local text = panel:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  text:SetJustifyH("LEFT")
  text:SetJustifyV("MIDDLE")
  text:SetWordWrap(true)
  text:SetText(caption)

  local button = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
  button:SetHeight(22)
  button:SetScript("OnClick", function()
    local s = tableRef()
    local index = 1
    for i, value in ipairs(values) do if value == s[key] then index = i end end
    s[key] = values[index % #values + 1]
    if panel.Refresh then panel:Refresh() end
  end)

  rows[#rows + 1] = {
    kind = "choice", text = text, button = button, key = key, values = values,
    labelFor = labelFor, indent = indent or 0, needs = needs,
  }
end

local function rowOn(s, row)
  if row.key == "enabled" then return true end
  if s.enabled ~= true then return false end
  if row.needs and s[row.needs] ~= true then return false end
  return true
end

local function registerCanvas()
  local panel = CreateFrame("Frame")
  panel.name = L.WINDOW_TITLE
  local rows = {}

  local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
  title:SetJustifyH("LEFT")
  title:SetWordWrap(true)
  title:SetText(L.OPT_PRO_TITLE)

  addCheck(panel, rows, "enabled", L.OPT_PRO_MASTER, L.OPT_PRO_MASTER_TIP, 0)
  addCheck(panel, rows, "level", L.OPT_PRO_LEVEL, L.OPT_PRO_LEVEL_TIP, 1)
  addChoice(panel, rows, "levelEvery", L.OPT_PRO_LEVEL_EVERY, LEVEL_STEPS, everyLabel, 2, "level")
  for _, key in ipairs({ "zone", "dungeon", "profession", "talents" }) do
    addCheck(panel, rows, key, L["OPT_PRO_" .. key:upper()], L["OPT_PRO_" .. key:upper() .. "_TIP"], 1)
  end
  addChoice(panel, rows, "cooldownMin", L.OPT_PRO_COOLDOWN, COOLDOWNS, minutesLabel, 1)

  function panel:Layout()
    if self.layingOut then return end
    self.layingOut = true
    local width = self:GetWidth()
    if not width or width < 200 then width = 560 end
    local y = -PAD
    title:ClearAllPoints()
    title:SetPoint("TOPLEFT", PAD, y)
    title:SetWidth(width - PAD * 2)
    y = y - textHeight(title, width - PAD * 2) - 14

    for _, row in ipairs(rows) do
      local x = PAD + row.indent * 20
      local textW = width - x - CHECK - GAP - PAD
      if textW < 80 then textW = 80 end
      if row.kind == "check" then
        row.cb:ClearAllPoints()
        row.cb:SetPoint("TOPLEFT", x, y)
        row.text:ClearAllPoints()
        row.text:SetPoint("TOPLEFT", row.cb, "TOPRIGHT", GAP, -4)
        local h = textHeight(row.text, textW)
        row.hit:ClearAllPoints()
        row.hit:SetPoint("TOPLEFT", row.text, "TOPLEFT", 0, 0)
        row.hit:SetSize(textW, math.max(h, CHECK))
        y = y - math.max(CHECK, h + 4) - 10
      else
        row.text:ClearAllPoints()
        row.text:SetPoint("TOPLEFT", x, y - 2)
        local capW = math.min(160, textW * 0.45)
        local h = textHeight(row.text, capW)
        row.button:ClearAllPoints()
        row.button:SetPoint("LEFT", row.text, "RIGHT", GAP, 0)
        y = y - math.max(22, h) - 10
      end
    end
    local needed = -y + PAD
    if math.abs((self:GetHeight() or 0) - needed) > 1 then
      self:SetHeight(needed)
    end
    self.layingOut = false
  end

  function panel:Refresh()
    local s = tableRef()
    for _, row in ipairs(rows) do
      local on = rowOn(s, row)
      if row.kind == "check" then
        row.cb:SetChecked(s[row.key] == true)
        row.cb:SetEnabled(on)
        row.hit:SetEnabled(on)
        paint(row.text, on)
      else
        local valueText = row.labelFor(s[row.key])
        row.button:SetText(valueText)
        local fs = row.button.GetFontString and row.button:GetFontString()
        local w = fs and fs:GetStringWidth() or 0
        row.button:SetWidth(math.max(120, (w > 0 and w or 80) + 28))
        row.button:SetEnabled(on)
        paint(row.text, on)
      end
    end
  end

  panel:SetScript("OnShow", function(self)
    self:Layout()
    self:Refresh()
  end)
  panel:SetScript("OnSizeChanged", function(self)
    if self:IsShown() then self:Layout() end
  end)

  if Settings and Settings.RegisterCanvasLayoutCategory then
    local category = Settings.RegisterCanvasLayoutCategory(panel, L.WINDOW_TITLE)
    Settings.RegisterAddOnCategory(category)
  elseif InterfaceOptions_AddCategory then
    InterfaceOptions_AddCategory(panel)
  end
end

local function register()
  if not ns.db or not ns.Proactive then return end
  ns.Proactive:EnsureSettings()
  registerCanvas()
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, _, name)
  if name ~= ADDON then return end
  frame:UnregisterEvent("ADDON_LOADED")
  register()
end)
