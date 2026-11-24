-- Proactive tips in the game's own settings: Esc → Options → AddOns →
-- Forever AI Companion. The switches live in the addon's saved variables
-- (ns.db.proactive). The companion app answers whatever the game sends.
local ADDON, ns = ...
local L = ns.L

local LEVEL_STEPS = { 1, 2, 5, 10 }
local COOLDOWNS = { 1, 3, 5, 10, 15, 30 }

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

-- Native list, the same controls as the rest of Options → AddOns.
local function registerVertical()
  local category, layout = Settings.RegisterVerticalLayoutCategory(L.WINDOW_TITLE)
  if layout and CreateSettingsListSectionHeaderInitializer then
    layout:AddInitializer(CreateSettingsListSectionHeaderInitializer(L.OPT_PRO_TITLE))
  end

  local function addCheckbox(key, name, tip, default)
    local setting = Settings.RegisterAddOnSetting(category, ADDON .. "_pro_" .. key, key, tableRef(), type(default), name, default)
    return setting, Settings.CreateCheckbox(category, setting, tip)
  end

  local function addDropdown(key, name, tip, default, choices)
    local setting = Settings.RegisterAddOnSetting(category, ADDON .. "_pro_" .. key, key, tableRef(), type(default), name, default)
    local function options()
      local container = Settings.CreateControlTextContainer()
      for _, choice in ipairs(choices) do container:Add(choice.value, choice.text) end
      return container:GetData()
    end
    return setting, Settings.CreateDropdown(category, setting, options, tip)
  end

  local function childOf(initializer, parentInit, parentSetting)
    if initializer and parentInit and initializer.SetParentInitializer then
      initializer:SetParentInitializer(parentInit, function() return parentSetting:GetValue() end)
    end
  end

  local masterSetting, master = addCheckbox("enabled", L.OPT_PRO_MASTER, L.OPT_PRO_MASTER_TIP, false)
  local kindInit, kindSetting = {}, {}
  for _, key in ipairs({ "level", "zone", "dungeon", "profession", "talents" }) do
    local setting, init = addCheckbox(key, L["OPT_PRO_" .. key:upper()], L["OPT_PRO_" .. key:upper() .. "_TIP"], true)
    kindInit[key], kindSetting[key] = init, setting
    childOf(init, master, masterSetting)
  end
  local _, every = addDropdown("levelEvery", L.OPT_PRO_LEVEL_EVERY, L.OPT_PRO_LEVEL_EVERY_TIP, 2, {
    { value = 1, text = everyLabel(1) },
    { value = 2, text = everyLabel(2) },
    { value = 5, text = everyLabel(5) },
    { value = 10, text = everyLabel(10) },
  })
  if every and kindInit.level and every.SetParentInitializer then
    every:SetParentInitializer(kindInit.level, function()
      return masterSetting:GetValue() and kindSetting.level:GetValue()
    end)
  end
  local cooldownChoices = {}
  for _, n in ipairs(COOLDOWNS) do cooldownChoices[#cooldownChoices + 1] = { value = n, text = minutesLabel(n) } end
  local _, cooldown = addDropdown("cooldownMin", L.OPT_PRO_COOLDOWN, L.OPT_PRO_COOLDOWN_TIP, 3, cooldownChoices)
  childOf(cooldown, master, masterSetting)

  Settings.RegisterAddOnCategory(category)
end

-- Older settings UI: a plain page of checkboxes in the same AddOns list.
local function registerCanvas()
  local panel = CreateFrame("Frame")
  panel.name = L.WINDOW_TITLE

  local title = panel:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", 16, -16)
  title:SetText(L.OPT_PRO_TITLE)

  local y = -48
  local boxes = {}
  local function addCheck(key, label, tip)
    local cb = CreateFrame("CheckButton", nil, panel, "UICheckButtonTemplate")
    cb:SetPoint("TOPLEFT", 16, y)
    local text = cb:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    text:SetPoint("LEFT", cb, "RIGHT", 2, 0)
    text:SetText(label)
    cb.tooltipText = tip
    cb.key = key
    cb:SetScript("OnClick", function(self)
      tableRef()[key] = self:GetChecked() and true or false
    end)
    boxes[#boxes + 1] = cb
    y = y - 28
    return cb
  end

  addCheck("enabled", L.OPT_PRO_MASTER, L.OPT_PRO_MASTER_TIP)
  for _, key in ipairs({ "level", "zone", "dungeon", "profession", "talents" }) do
    addCheck(key, L["OPT_PRO_" .. key:upper()], L["OPT_PRO_" .. key:upper() .. "_TIP"])
  end

  local function cycle(key, values, labelFor)
    local button = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
    button:SetSize(280, 22)
    button:SetPoint("TOPLEFT", 24, y)
    button.key, button.values, button.labelFor = key, values, labelFor
    button:SetScript("OnClick", function(self)
      local s = tableRef()
      local index = 1
      for i, value in ipairs(self.values) do if value == s[self.key] then index = i end end
      s[self.key] = self.values[index % #self.values + 1]
      self:SetText(self.labelFor(s[self.key]))
    end)
    boxes[#boxes + 1] = button
    y = y - 32
  end

  cycle("levelEvery", LEVEL_STEPS, function(n) return L.OPT_PRO_LEVEL_EVERY .. ": " .. everyLabel(n) end)
  cycle("cooldownMin", COOLDOWNS, function(n) return L.OPT_PRO_COOLDOWN .. ": " .. minutesLabel(n) end)

  panel:SetScript("OnShow", function()
    local s = tableRef()
    for _, widget in ipairs(boxes) do
      if widget.values then
        widget:SetText(widget.labelFor(s[widget.key]))
      else
        widget:SetChecked(s[widget.key] == true)
      end
    end
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
  if Settings and Settings.RegisterVerticalLayoutCategory and Settings.RegisterAddOnSetting and Settings.CreateCheckbox then
    local ok = pcall(registerVertical)
    if ok then return end
  end
  registerCanvas()
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(_, _, name)
  if name ~= ADDON then return end
  frame:UnregisterEvent("ADDON_LOADED")
  register()
end)
