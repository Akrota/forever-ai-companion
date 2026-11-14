-- Gathers a snapshot of the player's state for the AI.
-- Every section is wrapped in pcall: an API that is missing or behaves
-- differently on this client only drops that section, never the whole snapshot.
-- Both the modern (C_*) and the classic-style APIs are tried where they differ.
local _, ns = ...

local Collect = {}
ns.Collect = Collect

local floor, sqrt = math.floor, math.sqrt

local function safe(fn, ...)
  local ok, res = pcall(fn, ...)
  if ok then return res end
  return nil
end

-- Errors of the current snapshot, by section, so missing data can be diagnosed.
local errors

-- Like safe(), but remembers why a whole section failed.
local function section(name, fn, ...)
  local ok, res = pcall(fn, ...)
  if ok then return res end
  errors[name] = tostring(res):gsub("^.-:%d+: ", ""):sub(1, 120)
  return nil
end

-- Midnight-era clients can return "secret" values (e.g. unit health) that
-- addons may display but not compute with. Treat them as unknown.
local function secret(v)
  return issecretvalue and issecretvalue(v) or false
end

local function num(v)
  if v == nil or secret(v) or type(v) ~= "number" then return nil end
  return v
end

-- Sets t[key] = fn(), ignoring failures, so one bad field never drops the rest.
local function put(t, key, fn)
  local ok, v = pcall(fn)
  if ok and v ~= nil and not secret(v) then t[key] = v end
end

local function round(n, digits)
  n = num(n)
  if not n then return nil end
  local m = 10 ^ (digits or 0)
  return floor(n * m + 0.5) / m
end

local function pct(cur, max)
  cur, max = num(cur), num(max)
  if not cur or not max or max <= 0 then return nil end
  local ok, v = pcall(function() return floor(cur / max * 100 + 0.5) end)
  return ok and v or nil
end

local function money(copper)
  if type(copper) ~= "number" then return nil end
  return string.format("%dg %ds %dc", floor(copper / 10000), floor(copper / 100) % 100, copper % 100)
end

-- Strip WoW markup (colors, textures, hyperlinks) so the AI sees plain text.
local function clean(s)
  if type(s) ~= "string" then return s end
  s = s:gsub("|c%x%x%x%x%x%x%x%x", "")
  s = s:gsub("|cn[%w_]*:", "") -- newer clients color by name: "|cnIQ1:" = item quality 1
  s = s:gsub("|r", "")
  s = s:gsub("|T.-|t", "")
  s = s:gsub("|A.-|a", "")
  s = s:gsub("|H.-|h(.-)|h", "%1")
  s = s:gsub("|n", "\n")
  return s
end
Collect.Clean = clean

local GetItemInfo = (C_Item and C_Item.GetItemInfo) or GetItemInfo
local GetDetailedItemLevelInfo = (C_Item and C_Item.GetDetailedItemLevelInfo) or GetDetailedItemLevelInfo
local GetItemStats = (C_Item and C_Item.GetItemStats) or GetItemStats
local GetItemCooldown = (C_Container and C_Container.GetItemCooldown) or GetItemCooldown

local QUALITY = { [0] = "poor", "common", "uncommon", "rare", "epic", "legendary", "artifact", "heirloom" }
local HEARTHSTONE = 6948

local SLOTS = {
  { 1, "head" }, { 2, "neck" }, { 3, "shoulder" }, { 15, "back" }, { 5, "chest" },
  { 9, "wrist" }, { 10, "hands" }, { 6, "waist" }, { 7, "legs" }, { 8, "feet" },
  { 11, "finger1" }, { 12, "finger2" }, { 13, "trinket1" }, { 14, "trinket2" },
  { 16, "mainHand" }, { 17, "offHand" }, { 18, "ranged" },
}

-- Item stats as { AGILITY = 5, STAMINA = 3, DAMAGE_PER_SECOND = 12.4, ... }.
local function itemStats(link)
  if not GetItemStats then return nil end
  local ok, stats = pcall(GetItemStats, link)
  if not ok or type(stats) ~= "table" then return nil end
  local out, any = {}, false
  for k, v in pairs(stats) do
    if type(k) == "string" and type(v) == "number" then
      local key = k:gsub("^ITEM_MOD_", "")
      key = key:gsub("_SHORT$", "")
      out[key] = round(v, 1)
      any = true
    end
  end
  return any and out or nil
end

-- Common description of an item link. `full` adds stats and requirements.
local function describeItem(link, full)
  local name, _, quality, itemLevel, reqLevel, itemType, itemSubType, _, equipLoc = GetItemInfo(link)
  local item = {
    name = name or link:match("%[(.-)%]"),
    itemId = tonumber(link:match("item:(%d+)")),
    quality = QUALITY[quality] or quality,
    type = itemSubType or itemType,
  }
  local equippable = equipLoc and equipLoc ~= "" and equipLoc ~= "INVTYPE_NON_EQUIP_IGNORE"
  if equippable then
    item.equipSlot = equipLoc
    item.itemLevel = (GetDetailedItemLevelInfo and GetDetailedItemLevelInfo(link)) or itemLevel
  end
  if reqLevel and reqLevel > 1 then item.reqLevel = reqLevel end
  if full and equippable then item.stats = itemStats(link) end
  return item
end
Collect.DescribeItem = describeItem

-- Gear slots (names as in "gear") an equippable item would go in.
local SLOTS_FOR = {
  INVTYPE_HEAD = { "head" }, INVTYPE_NECK = { "neck" }, INVTYPE_SHOULDER = { "shoulder" },
  INVTYPE_CLOAK = { "back" }, INVTYPE_CHEST = { "chest" }, INVTYPE_ROBE = { "chest" },
  INVTYPE_WRIST = { "wrist" }, INVTYPE_HAND = { "hands" }, INVTYPE_WAIST = { "waist" },
  INVTYPE_LEGS = { "legs" }, INVTYPE_FEET = { "feet" }, INVTYPE_FINGER = { "finger1", "finger2" },
  INVTYPE_TRINKET = { "trinket1", "trinket2" }, INVTYPE_WEAPON = { "mainHand", "offHand" },
  INVTYPE_2HWEAPON = { "mainHand", "offHand" }, INVTYPE_WEAPONMAINHAND = { "mainHand" },
  INVTYPE_WEAPONOFFHAND = { "offHand" }, INVTYPE_SHIELD = { "offHand" }, INVTYPE_HOLDABLE = { "offHand" },
  INVTYPE_RANGED = { "ranged" }, INVTYPE_RANGEDRIGHT = { "ranged" }, INVTYPE_THROWN = { "ranged" },
  INVTYPE_RELIC = { "ranged" },
}

-- An item with everything needed to judge it: stats, and for gear the slots
-- it would replace (to compare with "gear").
local function fullItem(link)
  local item = describeItem(link, true)
  item.slots = item.equipSlot and SLOTS_FOR[item.equipSlot]
  return item
end

-- Links the player put in the question (shift-click on an item, spell,
-- quest...). Items come with their stats and the gear slots they would
-- replace; anything else just with its kind and name.
local MAX_LINKS = 5
function Collect:Links(text)
  if type(text) ~= "string" then return nil end
  local out, seen = {}, {}
  for data, shown in text:gmatch("|H(.-)|h(.-)|h") do
    if #out >= MAX_LINKS then break end
    local kind = data:match("^(%a+):")
    local name = clean(shown):gsub("^%[", ""):gsub("%]$", "")
    if kind and not seen[data] then
      seen[data] = true
      if kind == "item" then
        local item = safe(fullItem, data) or {}
        item.name = item.name or name
        out[#out + 1] = item
      else
        out[#out + 1] = { kind = kind, name = name, id = tonumber(data:match("^%a+:(%d+)")) }
      end
    end
  end
  return #out > 0 and out or nil
end

-- Character -----------------------------------------------------------------

local function character()
  local c = {}
  put(c, "name", function() return UnitName("player") end)
  put(c, "realm", function() return GetRealmName() end)
  put(c, "level", function() return UnitLevel("player") end)
  put(c, "race", function() return UnitRace("player") end)
  put(c, "raceToken", function() return select(2, UnitRace("player")) end)
  put(c, "class", function() return (UnitClass("player")) end)
  put(c, "classToken", function() return select(2, UnitClass("player")) end)
  put(c, "faction", function() return UnitFactionGroup("player") end)
  put(c, "sex", function()
    local sex = UnitSex("player")
    return (sex == 2 and "male") or (sex == 3 and "female") or nil
  end)
  put(c, "xp", function() return num(UnitXP("player")) end)
  put(c, "xpMax", function() return num(UnitXPMax("player")) end)
  put(c, "xpPct", function() return pct(c.xp, c.xpMax) end)
  put(c, "restedXp", function() return num(GetXPExhaustion()) or 0 end)
  put(c, "healthPct", function() return pct(UnitHealth("player"), UnitHealthMax("player")) end)
  put(c, "maxHealth", function() return num(UnitHealthMax("player")) end)
  put(c, "powerType", function() return select(2, UnitPowerType("player")) end)
  put(c, "maxPower", function() return num(UnitPowerMax("player")) end)
  put(c, "powerPct", function() return pct(UnitPower("player"), UnitPowerMax("player")) end)
  put(c, "money", function() return money(num(GetMoney())) end)
  put(c, "guild", function() return (GetGuildInfo("player")) end)
  put(c, "hearthstoneBind", function() return GetBindLocation() end)
  put(c, "hearthstoneCooldownMin", function()
    local start, duration = GetItemCooldown(HEARTHSTONE)
    start, duration = num(start), num(duration)
    if start and duration and duration > 0 then return round((start + duration - GetTime()) / 60, 1) end
  end)
  put(c, "pvpFlagged", function() return UnitIsPVP("player") or nil end)
  put(c, "dead", function() return UnitIsDeadOrGhost("player") or nil end)
  return c
end

-- Talents -------------------------------------------------------------------

-- Classic-style talent trees: points per tree and every talent with points.
local function classicTalents()
  if not (GetNumTalentTabs and GetTalentTabInfo and GetNumTalents and GetTalentInfo) then return nil end
  local trees = {}
  for tab = 1, GetNumTalentTabs() do
    local r = { GetTalentTabInfo(tab) }
    local tree = {}
    if type(r[1]) == "number" then
      tree.name, tree.points = r[2], r[5] -- id, name, description, icon, pointsSpent
    else
      tree.name, tree.points = r[1], r[3] -- name, icon, pointsSpent
    end
    local talents = {}
    for i = 1, GetNumTalents(tab) or 0 do
      local t = { GetTalentInfo(tab, i) }
      local name, rank, maxRank = t[1], t[5], t[6]
      if type(name) == "string" and type(rank) == "number" and rank > 0 then
        talents[#talents + 1] = string.format("%s %d/%d", name, rank, maxRank or rank)
      end
    end
    if #talents > 0 then tree.talents = talents end
    trees[#trees + 1] = tree
  end
  local out = { trees = trees }
  if UnitCharacterPoints then
    local unspent = UnitCharacterPoints("player")
    if unspent and unspent > 0 then out.unspentPoints = unspent end
  end
  return out
end

-- Modern talent loadout (C_ClassTalents / C_Traits): names of chosen talents.
local function modernTalents()
  if not (C_ClassTalents and C_ClassTalents.GetActiveConfigID and C_Traits) then return nil end
  local configID = C_ClassTalents.GetActiveConfigID()
  if not configID then return nil end
  local config = C_Traits.GetConfigInfo(configID)
  if not config or not config.treeIDs then return nil end
  local chosen = {}
  local getName = (C_Spell and C_Spell.GetSpellName) or GetSpellInfo
  for _, treeID in ipairs(config.treeIDs) do
    for _, nodeID in ipairs(C_Traits.GetTreeNodes(treeID) or {}) do
      local node = C_Traits.GetNodeInfo(configID, nodeID)
      if node and node.activeRank and node.activeRank > 0 and node.activeEntry then
        local entry = C_Traits.GetEntryInfo(configID, node.activeEntry.entryID)
        local def = entry and entry.definitionID and C_Traits.GetDefinitionInfo(entry.definitionID)
        local spellName = def and def.spellID and getName(def.spellID)
        if spellName then
          chosen[#chosen + 1] = node.maxRanks and node.maxRanks > 1
            and string.format("%s %d/%d", spellName, node.activeRank, node.maxRanks) or spellName
        end
      end
    end
  end
  return #chosen > 0 and { chosen = chosen } or nil
end

local function specialization()
  local s = {}
  if GetSpecialization and GetSpecializationInfo then
    local index = GetSpecialization()
    if index then
      local _, name, _, _, role = GetSpecializationInfo(index)
      s.spec, s.role = name, role
    end
  end
  s.talents = safe(classicTalents) or safe(modernTalents)
  return next(s) and s or nil
end

-- Stats ---------------------------------------------------------------------

local STAT_KEYS = { "strength", "agility", "stamina", "intellect", "spirit" }
local RESISTANCES = { [1] = "holy", [2] = "fire", [3] = "nature", [4] = "frost", [5] = "shadow", [6] = "arcane" }

local function sum3(a, b, c)
  a = num(a)
  if not a then return nil end
  return a + (num(b) or 0) + (num(c) or 0)
end

local function range(lo, hi)
  lo, hi = num(lo), num(hi)
  if lo and hi then return string.format("%d-%d", lo, hi) end
end

local function stats()
  local s = {}
  for i, key in ipairs(STAT_KEYS) do
    put(s, key, function() return num(select(2, UnitStat("player", i))) end)
  end
  put(s, "armor", function() local base, eff = UnitArmor("player"); return num(eff) or num(base) end)
  put(s, "attackPower", function() return sum3(UnitAttackPower("player")) end)
  put(s, "rangedAttackPower", function() return sum3(UnitRangedAttackPower("player")) end)
  put(s, "meleeDamage", function() return range(UnitDamage("player")) end)
  put(s, "meleeSpeed", function() return round(UnitAttackSpeed("player"), 2) end)
  put(s, "rangedSpeed", function() local speed = num(UnitRangedDamage("player")); return speed and speed > 0 and round(speed, 2) or nil end)
  put(s, "rangedDamage", function() return range(select(2, UnitRangedDamage("player"))) end)
  put(s, "critPct", function() return round(GetCritChance(), 2) end)
  put(s, "rangedCritPct", function() return round(GetRangedCritChance(), 2) end)
  put(s, "spellCritPct", function() return round(GetSpellCritChance(2), 2) end)
  put(s, "hitPct", function() return round(GetHitModifier(), 2) end)
  put(s, "spellPower", function() return num(GetSpellBonusDamage(2)) end)
  put(s, "healingPower", function() return num(GetSpellBonusHealing()) end)
  put(s, "hastePct", function() return round(GetHaste(), 2) end)
  put(s, "masteryPct", function() return round(GetMasteryEffect(), 2) end)
  put(s, "dodgePct", function() return round(GetDodgeChance(), 2) end)
  put(s, "parryPct", function() return round(GetParryChance(), 2) end)
  put(s, "blockPct", function() return round(GetBlockChance(), 2) end)
  put(s, "manaRegenPerSec", function() return round(GetManaRegen(), 1) end)
  put(s, "manaRegenCasting", function() return round(select(2, GetManaRegen()), 1) end)
  put(s, "resistances", function()
    local res = {}
    for i, key in pairs(RESISTANCES) do
      local total = num(select(2, UnitResistance("player", i)))
      if total and total > 0 then res[key] = total end
    end
    return next(res) and res or nil
  end)
  put(s, "itemLevel", function()
    local overall, equipped = GetAverageItemLevel()
    return round(num(equipped) or overall, 1)
  end)
  return s
end

-- Items ---------------------------------------------------------------------

local function gear()
  local items, empty = {}, {}
  local lowest
  for _, slot in ipairs(SLOTS) do
    local id, slotName = slot[1], slot[2]
    local link = GetInventoryItemLink("player", id)
    if link then
      local item = describeItem(link, true)
      item.slot = slotName
      item.equipSlot = nil
      local enchant = link:match("item:%d+:(%d+)")
      if enchant and enchant ~= "0" and enchant ~= "" then item.enchanted = true end
      local cur, max = GetInventoryItemDurability(id)
      if cur and max and max > 0 then
        item.durabilityPct = floor(cur / max * 100)
        if not lowest or item.durabilityPct < lowest then lowest = item.durabilityPct end
      end
      items[#items + 1] = item
    else
      empty[#empty + 1] = slotName
    end
  end
  return items, empty, lowest
end

-- Classic-style ammo slot (0). Returns nil on clients without one.
local function ammo()
  local link = GetInventoryItemLink("player", 0)
  if not link then return nil end
  local name = GetItemInfo(link) or link:match("%[(.-)%]")
  return { name = name, equipped = GetInventoryItemCount("player", 0) }
end

local function lastBag()
  return NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4
end

local function playerBags()
  local ids = {}
  for bag = 0, lastBag() do ids[#ids + 1] = bag end
  return ids
end

local function bankBags()
  local ids = {}
  if Enum and Enum.BagIndex and Enum.BagIndex.CharacterBankTab_1 then
    for i = 1, 6 do
      local id = Enum.BagIndex["CharacterBankTab_" .. i]
      if id then ids[#ids + 1] = id end
    end
  else
    ids[1] = BANK_CONTAINER or -1
    local first = lastBag() + 1
    for bag = first, first + (NUM_BANKBAGSLOTS or 7) - 1 do ids[#ids + 1] = bag end
  end
  return ids
end
Collect.BankBags = bankBags

local function bagSpace()
  local getFree = (C_Container and C_Container.GetContainerNumFreeSlots) or GetContainerNumFreeSlots
  local getSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
  if not getFree or not getSlots then return nil end
  local free, total = 0, 0
  for _, bag in ipairs(playerBags()) do
    free = free + (getFree(bag) or 0)
    total = total + (getSlots(bag) or 0)
  end
  return { freeSlots = free, totalSlots = total }
end

-- Contents of the given containers, grouped by item with total counts.
-- `full` adds stats for equippable items.
local function containerItems(bagIDs, full)
  local C = C_Container
  local getSlots = (C and C.GetContainerNumSlots) or GetContainerNumSlots
  local getLink = (C and C.GetContainerItemLink) or GetContainerItemLink
  if not getSlots then return nil end
  local byId, list = {}, {}
  for _, bag in ipairs(bagIDs) do
    for slot = 1, getSlots(bag) or 0 do
      local link, count
      if C and C.GetContainerItemInfo then
        local info = C.GetContainerItemInfo(bag, slot)
        if info then link, count = info.hyperlink, info.stackCount end
      elseif GetContainerItemInfo then
        local _, c, _, _, _, _, l = GetContainerItemInfo(bag, slot)
        link, count = l, c
      end
      if not link and getLink then link = getLink(bag, slot) end
      if link then
        local key = link:match("item:(%d+)") or link
        local entry = byId[key]
        if entry then
          entry.count = entry.count + (count or 1)
        else
          entry = describeItem(link, full)
          entry.count = count or 1
          byId[key] = entry
          list[#list + 1] = entry
        end
      end
    end
  end
  return list
end
Collect.ContainerItems = containerItems

-- Spells, auras, reputation, currencies ---------------------------------------

local function spells()
  local tabs = {}
  if C_SpellBook and C_SpellBook.GetNumSpellBookSkillLines then
    local bank = Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Player or 0
    for i = 1, C_SpellBook.GetNumSpellBookSkillLines() do
      local line = C_SpellBook.GetSpellBookSkillLineInfo(i)
      if line and not line.offSpecID and not line.shouldHide then
        local names, seen = {}, {}
        for j = line.itemIndexOffset + 1, line.itemIndexOffset + line.numSpellBookItems do
          local info = C_SpellBook.GetSpellBookItemInfo(j, bank)
          if info and info.name and not info.isPassive and not seen[info.name] then
            seen[info.name] = true
            names[#names + 1] = (info.subName and info.subName ~= "") and (info.name .. " (" .. info.subName .. ")") or info.name
          end
        end
        if #names > 0 then tabs[#tabs + 1] = { tab = line.name, spells = names } end
      end
    end
  elseif GetNumSpellTabs and GetSpellTabInfo and GetSpellBookItemName then
    for t = 1, GetNumSpellTabs() do
      local tabName, _, offset, num = GetSpellTabInfo(t)
      -- Keep the highest rank of each spell (ranks are listed in order).
      local order, best = {}, {}
      for i = offset + 1, offset + num do
        local name, rank = GetSpellBookItemName(i, BOOKTYPE_SPELL or "spell")
        local passive = IsPassiveSpell and IsPassiveSpell(i, BOOKTYPE_SPELL or "spell")
        if name and not passive then
          if not best[name] then order[#order + 1] = name end
          best[name] = (rank and rank ~= "") and (name .. " (" .. rank .. ")") or name
        end
      end
      local names = {}
      for _, n in ipairs(order) do names[#names + 1] = best[n] end
      if #names > 0 then tabs[#tabs + 1] = { tab = tabName, spells = names } end
    end
  end
  return #tabs > 0 and tabs or nil
end

local function auras(filter)
  local list = {}
  for i = 1, 40 do
    local name, count, expires
    if C_UnitAuras and C_UnitAuras.GetAuraDataByIndex then
      local a = C_UnitAuras.GetAuraDataByIndex("player", i, filter)
      if not a then break end
      name, count, expires = a.name, a.applications, a.expirationTime
    elseif UnitAura then
      local n, _, c, _, _, e = UnitAura("player", i, filter)
      if not n then break end
      name, count, expires = n, c, e
    else
      break
    end
    local e = { name = name }
    if count and count > 1 then e.stacks = count end
    if expires and expires > 0 then e.minutesLeft = round((expires - GetTime()) / 60, 1) end
    list[#list + 1] = e
  end
  return #list > 0 and list or nil
end

local function standingLabel(id)
  return id and _G["FACTION_STANDING_LABEL" .. id] or id
end

local function reputations()
  local list = {}
  if C_Reputation and C_Reputation.GetNumFactions and C_Reputation.GetFactionDataByIndex then
    for i = 1, C_Reputation.GetNumFactions() do
      local f = C_Reputation.GetFactionDataByIndex(i)
      if f and (not f.isHeader or f.isHeaderWithRep) then
        list[#list + 1] = {
          name = f.name,
          standing = standingLabel(f.reaction),
          progress = f.nextReactionThreshold and string.format("%d/%d",
            (f.currentStanding or 0) - (f.currentReactionThreshold or 0),
            (f.nextReactionThreshold or 0) - (f.currentReactionThreshold or 0)) or nil,
          atWar = f.atWarWith or nil,
        }
      end
    end
  elseif GetNumFactions and GetFactionInfo then
    for i = 1, GetNumFactions() do
      local name, _, standingID, barMin, barMax, barValue, atWar, _, isHeader, _, hasRep = GetFactionInfo(i)
      if name and (not isHeader or hasRep) then
        list[#list + 1] = {
          name = name,
          standing = standingLabel(standingID),
          progress = barMax and string.format("%d/%d", (barValue or 0) - (barMin or 0), barMax - (barMin or 0)) or nil,
          atWar = atWar or nil,
        }
      end
    end
  end
  return #list > 0 and list or nil
end

local function currencies()
  if not (C_CurrencyInfo and C_CurrencyInfo.GetCurrencyListSize) then return nil end
  local list = {}
  for i = 1, C_CurrencyInfo.GetCurrencyListSize() do
    local c = C_CurrencyInfo.GetCurrencyListInfo(i)
    if c and not c.isHeader and c.quantity and c.quantity > 0 then
      list[#list + 1] = { name = c.name, quantity = c.quantity, max = (c.maxQuantity and c.maxQuantity > 0) and c.maxQuantity or nil }
    end
  end
  return #list > 0 and list or nil
end

local function professions()
  local list = {}
  if GetProfessions and GetProfessionInfo then
    local slots = { GetProfessions() }
    for i = 1, 6 do
      local index = slots[i]
      if index then
        local name, _, rank, maxRank = GetProfessionInfo(index)
        list[#list + 1] = { name = name, rank = rank, max = maxRank }
      end
    end
  elseif GetNumSkillLines and GetSkillLineInfo then
    -- Classic: professions, secondary skills and weapon skills.
    local header
    for i = 1, GetNumSkillLines() do
      local name, isHeader, _, rank, _, _, maxRank = GetSkillLineInfo(i)
      if isHeader then
        header = name
      elseif name then
        list[#list + 1] = { name = name, rank = rank, max = maxRank, group = header }
      end
      if #list >= 40 then break end
    end
  end
  return #list > 0 and list or nil
end

-- World -----------------------------------------------------------------------

local DIRECTIONS = { "N", "NO", "O", "SO", "S", "SE", "E", "NE" }

local function position()
  local p = {}
  p.zone = GetRealZoneText()
  p.subzone = GetSubZoneText()
  if C_Map and C_Map.GetBestMapForUnit then
    local mapID = C_Map.GetBestMapForUnit("player")
    if mapID then
      p.mapId = mapID
      local info = C_Map.GetMapInfo(mapID)
      if info then
        p.mapName = info.name
        -- Walk up to the continent.
        local continentType = Enum and Enum.UIMapType and Enum.UIMapType.Continent or 2
        local cur, guard = info, 0
        while cur and cur.parentMapID and cur.parentMapID > 0 and guard < 6 do
          cur = C_Map.GetMapInfo(cur.parentMapID)
          guard = guard + 1
          if cur and cur.mapType == continentType then p.continent = cur.name break end
        end
      end
      local pos = C_Map.GetPlayerMapPosition(mapID, "player")
      if pos then
        local x, y = pos:GetXY()
        if x and y then
          p.x = round(x * 100, 1)
          p.y = round(y * 100, 1)
        end
      end
    end
  end
  if GetPlayerFacing then
    local facing = GetPlayerFacing()
    if facing then p.facing = DIRECTIONS[floor(facing / (2 * math.pi) * 8 + 0.5) % 8 + 1] end
  end
  if GetZonePVPInfo then p.zonePvp = GetZonePVPInfo() end
  local inInstance, instanceType = IsInInstance()
  if inInstance then
    p.instanceType = instanceType
    local name, _, _, difficultyName = GetInstanceInfo()
    p.instanceName = name
    p.difficulty = difficultyName
  end
  p.resting = IsResting() or nil
  p.mounted = (IsMounted and IsMounted()) or nil
  p.swimming = (IsSwimming and IsSwimming()) or nil
  p.flying = (IsFlying and IsFlying()) or nil
  p.indoors = (IsIndoors and IsIndoors()) or nil
  return p
end

-- Quests ----------------------------------------------------------------------

local function questRewards(q, questID, logIndex)
  if GetQuestLogRewardXP then
    local xp = GetQuestLogRewardXP(questID)
    if xp and xp > 0 then q.rewardXp = xp end
  end
  if GetQuestLogRewardMoney then
    local m = GetQuestLogRewardMoney(questID)
    if m and m > 0 then q.rewardMoney = money(m) end
  end
  local function items(kind, numFn, infoFn)
    local n = numFn and safe(numFn, questID) or 0
    if not n or n == 0 then return nil end
    local list = {}
    for i = 1, n do
      local link = GetQuestLogItemLink and safe(GetQuestLogItemLink, kind, i, questID)
      if link then
        local it = describeItem(link, true)
        list[#list + 1] = it
      elseif infoFn then
        local name, _, count = infoFn(i, questID)
        if name then list[#list + 1] = { name = name, count = count } end
      end
    end
    return #list > 0 and list or nil
  end
  q.rewardItems = items("reward", GetNumQuestLogRewards, GetQuestLogRewardInfo)
  q.rewardChoices = items("choice", GetNumQuestLogChoices, GetQuestLogChoiceInfo)
end

-- Where a quest is done and where to go next, from the game's own map:
-- "where" = the quest's area on its zone map, "waypoint" = next stop (e.g. the
-- turn-in). Coordinates 0-100 like the game's map.
local mapNames = {}
local function mapName(id)
  if mapNames[id] == nil then
    local info = C_Map and C_Map.GetMapInfo and C_Map.GetMapInfo(id)
    mapNames[id] = info and info.name or false
  end
  return mapNames[id] or nil
end

local function spot(mapID, x, y)
  x, y = num(x), num(y)
  if not (mapID and x and y) or (x == 0 and y == 0) then return nil end
  return { zone = mapName(mapID), x = round(x * 100, 1), y = round(y * 100, 1) }
end

local function questLocation(q, questID, onMap)
  if C_QuestLog.GetNextWaypoint then
    local mapID, x, y = C_QuestLog.GetNextWaypoint(questID)
    q.waypoint = spot(mapID, x, y)
  end
  local uiMap = GetQuestUiMapID and GetQuestUiMapID(questID)
  if uiMap and uiMap > 0 and C_QuestLog.GetQuestsOnMap then
    if onMap[uiMap] == nil then onMap[uiMap] = C_QuestLog.GetQuestsOnMap(uiMap) or false end
    for _, info in ipairs(onMap[uiMap] or {}) do
      if info.questID == questID then
        q.where = spot(uiMap, info.x, info.y)
        break
      end
    end
  end
end

local function questsModern()
  local list = {}
  local header
  local onMap = {}
  for i = 1, C_QuestLog.GetNumQuestLogEntries() do
    local info = C_QuestLog.GetInfo(i)
    if info then
      if info.isHeader then
        header = info.title
      elseif not info.isHidden then
        local id = info.questID
        local q = { title = info.title, level = info.level, id = id, zone = header }
        if info.suggestedGroup and info.suggestedGroup > 1 then q.group = info.suggestedGroup end
        if C_QuestLog.IsComplete and C_QuestLog.IsComplete(id) then q.complete = true end
        if C_QuestLog.IsFailed and C_QuestLog.IsFailed(id) then q.failed = true end
        if C_QuestLog.GetQuestTagInfo then
          local tag = C_QuestLog.GetQuestTagInfo(id)
          if tag and tag.tagName then q.tag = tag.tagName end
        end
        local objectives = C_QuestLog.GetQuestObjectives and C_QuestLog.GetQuestObjectives(id)
        if objectives and #objectives > 0 then
          q.objectives = {}
          for _, o in ipairs(objectives) do
            q.objectives[#q.objectives + 1] = (o.finished and "[x] " or "[ ] ") .. clean(o.text or "")
          end
        end
        if GetQuestLogQuestText then
          local _, objectiveText = GetQuestLogQuestText(i)
          if objectiveText and objectiveText ~= "" then q.goal = clean(objectiveText) end
        end
        if C_QuestLog.GetNextWaypointText then
          local wp = C_QuestLog.GetNextWaypointText(id)
          if wp and wp ~= "" then q.nextStep = clean(wp) end
        end
        if C_QuestLog.GetDistanceSqToQuest then
          local distSq, onContinent = C_QuestLog.GetDistanceSqToQuest(id)
          if distSq and onContinent then q.distanceYards = floor(sqrt(distSq)) end
        end
        safe(questLocation, q, id, onMap)
        safe(questRewards, q, id, i)
        list[#list + 1] = q
      end
    end
  end
  return list
end

local function questsClassic()
  local list = {}
  local header
  local selected = GetQuestLogSelection and GetQuestLogSelection()
  for i = 1, GetNumQuestLogEntries() do
    local title, level, suggestedGroup, isHeader, _, isComplete, _, questID = GetQuestLogTitle(i)
    if isHeader then
      header = title
    elseif title then
      local q = { title = title, level = level, id = questID, zone = header }
      if type(suggestedGroup) == "number" and suggestedGroup > 1 then q.group = suggestedGroup end
      if isComplete == 1 or isComplete == true then q.complete = true end
      if isComplete == -1 then q.failed = true end
      local n = GetNumQuestLeaderBoards and GetNumQuestLeaderBoards(i) or 0
      if n > 0 then
        q.objectives = {}
        for j = 1, n do
          local text, _, finished = GetQuestLogLeaderBoard(j, i)
          q.objectives[#q.objectives + 1] = (finished and "[x] " or "[ ] ") .. clean(text or "")
        end
      end
      if SelectQuestLogEntry and GetQuestLogQuestText then
        SelectQuestLogEntry(i)
        local _, objectiveText = GetQuestLogQuestText()
        if objectiveText and objectiveText ~= "" then q.goal = clean(objectiveText) end
        if questID then safe(questRewards, q, questID, i) end
      end
      list[#list + 1] = q
    end
  end
  if selected and SelectQuestLogEntry then SelectQuestLogEntry(selected) end
  return list
end

local function quests()
  if C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo then
    return questsModern()
  elseif GetNumQuestLogEntries and GetQuestLogTitle then
    return questsClassic()
  end
  return nil
end

-- Dungeons and raids with an active lockout.
local raidInfoRequested = false
local function lockouts()
  if not (GetNumSavedInstances and GetSavedInstanceInfo) then return nil end
  if not raidInfoRequested and RequestRaidInfo then raidInfoRequested = true; pcall(RequestRaidInfo) end
  local list = {}
  for i = 1, GetNumSavedInstances() do
    local name, _, reset, _, locked, extended, _, isRaid, maxPlayers, difficultyName = GetSavedInstanceInfo(i)
    if name and (locked or extended) then
      list[#list + 1] = { name = name, raid = isRaid or nil, players = num(maxPlayers), difficulty = difficultyName,
        resetHours = num(reset) and round(reset / 3600, 1) or nil }
    end
  end
  return #list > 0 and list or nil
end

-- Weapon, armor, riding and language skills (when the client lists them;
-- professions have their own section).
local function skills()
  if not (GetProfessions and GetNumSkillLines and GetSkillLineInfo) then return nil end
  local list, header = {}, nil
  for i = 1, GetNumSkillLines() do
    local name, isHeader, _, rank, _, _, maxRank = GetSkillLineInfo(i)
    if isHeader then
      header = name
    elseif name then
      list[#list + 1] = { name = name, rank = rank, max = maxRank, group = header }
    end
    if #list >= 40 then break end
  end
  return #list > 0 and list or nil
end

-- Others ----------------------------------------------------------------------

local HAPPINESS = { "unhappy", "content", "happy" }

local function pet()
  if not UnitExists("pet") then return nil end
  local p = {}
  put(p, "name", function() return UnitName("pet") end)
  put(p, "level", function() return UnitLevel("pet") end)
  put(p, "family", function() return UnitCreatureFamily("pet") end)
  put(p, "healthPct", function() return pct(UnitHealth("pet"), UnitHealthMax("pet")) end)
  put(p, "happiness", function() local h = GetPetHappiness(); return h and (HAPPINESS[h] or h) end)
  put(p, "damagePct", function() return num(select(2, GetPetHappiness())) end)
  put(p, "loyaltyRate", function() return num(select(3, GetPetHappiness())) end)
  put(p, "xpPct", function() local cur, max = GetPetExperience(); return pct(cur, max) end)
  return p
end

local function group()
  local n = GetNumGroupMembers and GetNumGroupMembers() or 0
  if n == 0 then return { size = 1 } end
  local g = { size = n, raid = IsInRaid() or nil }
  if not IsInRaid() then
    g.members = {}
    for i = 1, n - 1 do
      local unit = "party" .. i
      if UnitExists(unit) then
        local className = UnitClass(unit)
        local role = UnitGroupRolesAssigned and UnitGroupRolesAssigned(unit) or nil
        local m = { level = UnitLevel(unit), class = className, role = role }
        put(m, "healthPct", function() return pct(UnitHealth(unit), UnitHealthMax(unit)) end)
        g.members[#g.members + 1] = m
      end
    end
  end
  return g
end

local function target()
  if not UnitExists("target") then return nil end
  local t = {}
  put(t, "name", function() return UnitName("target") end)
  put(t, "level", function() return UnitLevel("target") end)
  put(t, "classification", function() return UnitClassification("target") end)
  put(t, "creatureType", function() return UnitCreatureType("target") end)
  put(t, "healthPct", function() return pct(UnitHealth("target"), UnitHealthMax("target")) end)
  put(t, "hostile", function() return UnitIsEnemy("player", "target") or nil end)
  put(t, "canAttack", function() return UnitCanAttack("player", "target") or nil end)
  put(t, "isPlayer", function() return UnitIsPlayer("target") or nil end)
  put(t, "dead", function() return UnitIsDead("target") or nil end)
  if t.isPlayer then
    put(t, "class", function() return (UnitClass("target")) end)
    put(t, "race", function() return (UnitRace("target")) end)
  end
  return t
end

local function client()
  local version, build, _, interface = GetBuildInfo()
  return { version = version, build = build, interface = interface, locale = GetLocale() }
end


-- Windows open on screen ---------------------------------------------------------
-- What the player is looking at while asking: a quest being offered or turned
-- in, an NPC's dialogue, a vendor, a trainer, the loot window. Only sent while
-- that window is open, so it costs nothing the rest of the time.

local open = {} -- window -> true, from the game's open/close events
local OPEN_EVENTS = {
  MERCHANT_SHOW = { "merchant", true }, MERCHANT_CLOSED = { "merchant", false },
  TRAINER_SHOW = { "trainer", true }, TRAINER_CLOSED = { "trainer", false },
  GOSSIP_SHOW = { "gossip", true }, GOSSIP_CLOSED = { "gossip", false },
  LOOT_OPENED = { "loot", true }, LOOT_CLOSED = { "loot", false },
  QUEST_GREETING = { "quest", "greeting" }, QUEST_DETAIL = { "quest", "detail" },
  QUEST_PROGRESS = { "quest", "progress" }, QUEST_COMPLETE = { "quest", "complete" },
  QUEST_FINISHED = { "quest", false },
}
Collect.open = open
local openWatcher = CreateFrame and CreateFrame("Frame")
if openWatcher then
  for e in pairs(OPEN_EVENTS) do pcall(openWatcher.RegisterEvent, openWatcher, e) end
  openWatcher:SetScript("OnEvent", function(_, event)
    local w = OPEN_EVENTS[event]
    if w then open[w[1]] = w[2] or nil end
  end)
end

-- The window may have been closed without its event (e.g. a /reload).
local function shown(frameName)
  local f = _G[frameName]
  return not f or not f.IsShown or f:IsShown()
end

local MAX_TEXT = 700
local function text(s)
  s = clean(s)
  if type(s) ~= "string" or s == "" then return nil end
  return #s > MAX_TEXT and (s:sub(1, MAX_TEXT) .. "...") or s
end

-- Rewards shown in the quest window ("reward" items, "choice" items to pick one).
local function questWindowRewards()
  local r = {}
  put(r, "xp", function() local xp = num(GetRewardXP()); return xp and xp > 0 and xp or nil end)
  put(r, "money", function() local m = num(GetRewardMoney()); return m and m > 0 and money(m) or nil end)
  local function items(kind, count)
    local list = {}
    for i = 1, math.min(num(count) or 0, 10) do
      local link = GetQuestItemLink(kind, i)
      local _, _, n = GetQuestItemInfo(kind, i)
      local item = link and safe(fullItem, link) or { name = (GetQuestItemInfo(kind, i)) }
      if n and n > 1 then item.count = n end
      list[#list + 1] = item
    end
    return #list > 0 and list or nil
  end
  put(r, "items", function() return items("reward", GetNumQuestRewards()) end)
  put(r, "choices", function() return items("choice", GetNumQuestChoices()) end)
  return next(r) and r or nil
end

local function questWindow()
  local state = open.quest
  if not state or not shown("QuestFrame") then return nil end
  local q = { npc = safe(UnitName, "npc") }
  if state == "greeting" then
    local available, active = {}, {}
    for i = 1, num(GetNumAvailableQuests and GetNumAvailableQuests()) or 0 do available[#available + 1] = GetAvailableTitle(i) end
    for i = 1, num(GetNumActiveQuests and GetNumActiveQuests()) or 0 do active[#active + 1] = GetActiveTitle(i) end
    q.availableQuests = #available > 0 and available or nil
    q.activeQuests = #active > 0 and active or nil
    return { questGreeting = q }
  end
  put(q, "title", function() return clean(GetTitleText()) end)
  put(q, "questId", function() local id = num(GetQuestID()); return id and id > 0 and id or nil end)
  if state == "detail" then
    put(q, "text", function() return text(GetQuestText()) end)
    put(q, "objectives", function() return text(GetObjectiveText()) end)
    q.rewards = questWindowRewards()
    return { questOffer = q }
  elseif state == "progress" then
    put(q, "text", function() return text(GetProgressText()) end)
    put(q, "canComplete", function() return IsQuestCompletable() and true or false end)
    local needed = {}
    for i = 1, num(GetNumQuestItems and GetNumQuestItems()) or 0 do
      local name, _, count = GetQuestItemInfo("required", i)
      if name then needed[#needed + 1] = { name = name, count = count } end
    end
    q.requiredItems = #needed > 0 and needed or nil
    return { questProgress = q }
  elseif state == "complete" then
    put(q, "text", function() return text(GetRewardText()) end)
    q.rewards = questWindowRewards()
    return { questReward = q }
  end
end

local function gossipWindow()
  if not open.gossip or not shown("GossipFrame") or not C_GossipInfo then return nil end
  local g = { npc = safe(UnitName, "npc") }
  put(g, "text", function() return text(C_GossipInfo.GetText()) end)
  put(g, "options", function()
    local list = {}
    for _, o in ipairs(C_GossipInfo.GetOptions() or {}) do list[#list + 1] = clean(o.name) end
    return #list > 0 and list or nil
  end)
  put(g, "availableQuests", function()
    local list = {}
    for _, q in ipairs(C_GossipInfo.GetAvailableQuests() or {}) do
      list[#list + 1] = { title = q.title, level = q.questLevel, trivial = q.isTrivial or nil }
    end
    return #list > 0 and list or nil
  end)
  put(g, "activeQuests", function()
    local list = {}
    for _, q in ipairs(C_GossipInfo.GetActiveQuests() or {}) do
      list[#list + 1] = { title = q.title, complete = q.isComplete or nil }
    end
    return #list > 0 and list or nil
  end)
  return g
end

local MAX_MERCHANT = 60
local function merchantWindow()
  if not open.merchant or not shown("MerchantFrame") then return nil end
  local m = { npc = safe(UnitName, "npc"), items = {} }
  for i = 1, math.min(num(GetMerchantNumItems()) or 0, MAX_MERCHANT) do
    local name, price, stack, available, usable, extended
    if C_MerchantFrame and C_MerchantFrame.GetItemInfo then
      local info = C_MerchantFrame.GetItemInfo(i)
      if info then
        name, price, stack, available, usable, extended =
          info.name, info.price, info.stackCount, info.numAvailable, info.isUsable, info.hasExtendedCost
      end
    else
      local _
      name, _, price, stack, available, _, usable, extended = GetMerchantItemInfo(i)
    end
    local link = GetMerchantItemLink(i)
    local item = link and safe(fullItem, link) or { name = name }
    if name or item.name then
      item.price = (num(price) and price > 0) and money(price) or nil
      if extended then item.otherCost = true end
      if num(stack) and stack > 1 then item.stack = stack end
      if num(available) and available >= 0 then item.limited = available end
      if usable == false then item.usable = false end
      m.items[#m.items + 1] = item
    end
  end
  put(m, "canRepair", function() return CanMerchantRepair() and true or nil end)
  if m.canRepair then
    put(m, "repairAllCost", function() local c = num(GetRepairAllCost()); return c and c > 0 and money(c) or nil end)
  end
  return m
end

local MAX_TRAINER = 80
local function trainerWindow()
  if not open.trainer or not GetNumTrainerServices then return nil end
  local t = { npc = safe(UnitName, "npc"), services = {} }
  for i = 1, num(GetNumTrainerServices()) or 0 do
    local name, sub, status = GetTrainerServiceInfo(i)
    if name and (status == "available" or status == "unavailable") then
      local s = { name = name, rank = (sub ~= "" and sub) or nil, status = status }
      put(s, "cost", function() return money(num(GetTrainerServiceCost(i))) end)
      put(s, "level", function() local l = num(GetTrainerServiceLevelReq(i)); return l and l > 1 and l or nil end)
      put(s, "needsSkill", function()
        local skill, rank, has = GetTrainerServiceSkillReq(i)
        return (skill and not has) and (skill .. " " .. tostring(rank)) or nil
      end)
      t.services[#t.services + 1] = s
      if #t.services >= MAX_TRAINER then break end
    end
  end
  return t
end

local function lootWindow()
  if not open.loot or not GetNumLootItems then return nil end
  local list = {}
  for i = 1, math.min(num(GetNumLootItems()) or 0, 20) do
    local link = GetLootSlotLink(i)
    local _, name, count = GetLootSlotInfo(i)
    local item = link and safe(fullItem, link) or { name = name }
    if num(count) and count > 1 then item.count = count end
    if item.name then list[#list + 1] = item end
  end
  return #list > 0 and list or nil
end

local function screen()
  local s = {}
  local quest = safe(questWindow)
  if quest then for k, v in pairs(quest) do s[k] = v end end
  s.gossip = safe(gossipWindow)
  s.merchant = safe(merchantWindow)
  s.trainer = safe(trainerWindow)
  s.loot = safe(lootWindow)
  return next(s) and s or nil
end

-- Recipes ------------------------------------------------------------------------
-- The game only lists a profession's recipes while its window is open, so they
-- are read then and remembered (Core:RememberRecipes), like the bank.

-- Chance to skill up, from the color the game shows.
local DIFFICULTY = { optimal = "orange", medium = "yellow", easy = "green", trivial = "grey" }
local MAX_RECIPES = 250
Collect.DIFFICULTY = DIFFICULTY

local function reagentText(parts)
  return #parts > 0 and table.concat(parts, ", ") or nil
end

-- Classic-style window (GetTradeSkillInfo).
local function classicRecipes()
  local profession, rank, max = GetTradeSkillLine()
  if not profession or profession == "UNKNOWN" then return nil end
  local list = {}
  for i = 1, num(GetNumTradeSkills()) or 0 do
    local name, kind, available = GetTradeSkillInfo(i)
    if name and kind ~= "header" and kind ~= "subheader" then
      local r = { name = name, difficulty = DIFFICULTY[kind] or kind }
      if num(available) and available > 0 then r.canMake = available end
      if kind ~= "trivial" and GetTradeSkillNumReagents then
        local parts = {}
        for j = 1, num(GetTradeSkillNumReagents(i)) or 0 do
          local reagent, _, need = GetTradeSkillReagentInfo(i, j)
          if reagent then parts[#parts + 1] = (need or 1) .. "x " .. reagent end
        end
        r.reagents = reagentText(parts)
      end
      list[#list + 1] = r
      if #list >= MAX_RECIPES then break end
    end
  end
  return { profession = profession, rank = num(rank), max = num(max), recipes = list }
end

-- Classic enchanting-style window (GetCraftInfo).
local function classicCrafts()
  if not GetCraftDisplaySkillLine then return nil end
  local profession, rank, max = GetCraftDisplaySkillLine()
  if not profession then return nil end -- e.g. the hunter's beast training
  local list = {}
  for i = 1, num(GetNumCrafts()) or 0 do
    local name, _, kind, available = GetCraftInfo(i)
    if name and kind ~= "header" then
      local r = { name = name, difficulty = DIFFICULTY[kind] or kind }
      if num(available) and available > 0 then r.canMake = available end
      if kind ~= "trivial" and GetCraftNumReagents then
        local parts = {}
        for j = 1, num(GetCraftNumReagents(i)) or 0 do
          local reagent, _, need = GetCraftReagentInfo(i, j)
          if reagent then parts[#parts + 1] = (need or 1) .. "x " .. reagent end
        end
        r.reagents = reagentText(parts)
      end
      list[#list + 1] = r
      if #list >= MAX_RECIPES then break end
    end
  end
  return { profession = profession, rank = num(rank), max = num(max), recipes = list }
end

-- Modern window (C_TradeSkillUI).
local MODERN_DIFFICULTY = { [0] = "orange", "yellow", "green", "grey" }
local function modernRecipes()
  local T = C_TradeSkillUI
  local info = (T.GetChildProfessionInfo and T.GetChildProfessionInfo()) or (T.GetBaseProfessionInfo and T.GetBaseProfessionInfo())
  local profession = info and (info.professionName or info.parentProfessionName)
  if not profession or profession == "" then return nil end
  local list = {}
  for _, id in ipairs(T.GetAllRecipeIDs() or {}) do
    local r = T.GetRecipeInfo(id)
    if r and r.learned and r.name then
      local entry = { name = r.name, difficulty = MODERN_DIFFICULTY[r.relativeDifficulty] }
      if num(r.numAvailable) and r.numAvailable > 0 then entry.canMake = r.numAvailable end
      if entry.difficulty ~= "grey" and T.GetRecipeSchematic then
        local parts = {}
        local schematic = safe(T.GetRecipeSchematic, id, false)
        for _, slot in ipairs(schematic and schematic.reagentSlotSchematics or {}) do
          local reagent = slot.reagents and slot.reagents[1]
          local itemName = reagent and reagent.itemID and GetItemInfo(reagent.itemID)
          if itemName then parts[#parts + 1] = (slot.quantityRequired or 1) .. "x " .. itemName end
        end
        entry.reagents = reagentText(parts)
      end
      list[#list + 1] = entry
      if #list >= MAX_RECIPES then break end
    end
  end
  return { profession = profession, rank = num(info.skillLevel), max = num(info.maxSkillLevel), recipes = list }
end

-- The profession whose window is open: { profession, rank, max, recipes }.
-- kind: "craft" for the classic enchanting-style window.
function Collect:Recipes(kind)
  if kind == "craft" then return safe(classicCrafts) end
  if C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs then
    local modern = safe(modernRecipes)
    if modern and #modern.recipes > 0 then return modern end
  end
  if GetTradeSkillLine and GetNumTradeSkills then return safe(classicRecipes) end
end

-- Data the addon remembers between sessions (bank, flight paths, quests turned in).
local function remembered()
  local out = {}
  local data = ns.Core and ns.Core:CharData()
  if not data then return out end
  if data.bank and data.bank.items then
    out.bank = { seenAt = data.bank.seenAt, items = data.bank.items }
  end
  if data.flightPaths and next(data.flightPaths) then
    local names = {}
    for name in pairs(data.flightPaths) do names[#names + 1] = name end
    table.sort(names)
    out.knownFlightPaths = names
  end
  if data.turnedIn and #data.turnedIn > 0 then out.recentlyCompletedQuests = data.turnedIn end
  if data.recipes and next(data.recipes) then
    local list = {}
    for _, p in pairs(data.recipes) do list[#list + 1] = p end
    table.sort(list, function(a, b) return tostring(a.profession) < tostring(b.profession) end)
    out.knownRecipes = list
  end
  return out
end

-- Sections, in order. Each returns { key = value, ... } for the snapshot.
-- `events`: the section is only recomputed after one of them fires (it is
-- cached otherwise, which keeps asking cheap). No `events`: always recomputed.
-- `once`: computed a single time per session.
local unpackArgs = unpack or table.unpack
local function one(key, fn, ...)
  local args = { ... }
  local n = select("#", ...)
  return function() return { [key] = fn(unpackArgs(args, 1, n)) } end
end

local SECTIONS = {
  { "client", one("client", client), once = true },
  { "character", one("character", character) },
  { "specialization", one("specialization", specialization), events = {
    "PLAYER_TALENT_UPDATE", "CHARACTER_POINTS_CHANGED", "TRAIT_CONFIG_UPDATED",
    "ACTIVE_TALENT_GROUP_CHANGED", "PLAYER_SPECIALIZATION_CHANGED", "PLAYER_LEVEL_UP" } },
  { "stats", one("stats", stats) },
  { "gear", function()
      local items, empty, lowest = gear()
      return { gear = items, emptySlots = (#empty > 0) and empty or nil, lowestDurabilityPct = lowest }
    end, events = { "PLAYER_EQUIPMENT_CHANGED", "UPDATE_INVENTORY_DURABILITY", "GET_ITEM_INFO_RECEIVED" } },
  { "ammo", one("ammo", ammo) },
  { "bags", one("bags", bagSpace) },
  { "inventory", one("inventory", containerItems, playerBags(), true), events = {
    "BAG_UPDATE_DELAYED", "GET_ITEM_INFO_RECEIVED" } },
  { "position", one("position", position) },
  { "quests", one("quests", quests), events = { "QUEST_LOG_UPDATE", "GET_ITEM_INFO_RECEIVED" } },
  { "professions", one("professions", professions), events = { "SKILL_LINES_CHANGED", "PLAYER_LEVEL_UP" } },
  { "skills", one("skills", skills), events = { "SKILL_LINES_CHANGED", "PLAYER_LEVEL_UP" } },
  { "lockouts", one("lockouts", lockouts), events = { "UPDATE_INSTANCE_INFO", "PLAYER_ENTERING_WORLD" } },
  { "spells", one("spells", spells), events = { "SPELLS_CHANGED", "LEARNED_SPELL_IN_TAB" } },
  { "buffs", one("buffs", auras, "HELPFUL") },
  { "debuffs", one("debuffs", auras, "HARMFUL") },
  { "reputations", one("reputations", reputations), events = { "UPDATE_FACTION" } },
  { "currencies", one("currencies", currencies), events = { "CURRENCY_DISPLAY_UPDATE" } },
  { "pet", one("pet", pet) },
  { "group", one("group", group) },
  { "target", one("target", target) },
  { "screen", one("screen", screen) },
  { "remembered", remembered },
}

-- cache[section] = { keys = { key = { value, json, hash } } }
Collect.cache = {}
Collect.dirty = {}

local watcher = CreateFrame and CreateFrame("Frame")
if watcher then
  local byEvent = {}
  for _, s in ipairs(SECTIONS) do
    for _, e in ipairs(s.events or {}) do
      byEvent[e] = byEvent[e] or {}
      table.insert(byEvent[e], s[1])
      pcall(watcher.RegisterEvent, watcher, e)
    end
  end
  watcher:SetScript("OnEvent", function(_, event)
    for _, name in ipairs(byEvent[event] or {}) do Collect.dirty[name] = true end
  end)
end

-- Reads every section (recomputing only what is needed), calling step()
-- between sections so the work can be spread over several frames.
-- Returns snap (key -> value), meta (key -> { json, hash }) and the errors.
function Collect:Gather(step)
  step = step or function() end
  errors = {}
  local snap, meta = {}, {}
  for _, s in ipairs(SECTIONS) do
    local name = s[1]
    local entry = self.cache[name]
    local fresh = entry and (s.once or (s.events and not self.dirty[name]))
    if not fresh then
      self.dirty[name] = nil
      local ok, res = pcall(s[2])
      if ok then
        entry = { keys = {} }
        for k, v in pairs(res or {}) do
          local json = ns.Json.Encode(v)
          entry.keys[k] = { value = v, json = json, hash = ns.Json.Hash(json) }
        end
      else
        errors[name] = tostring(res):gsub("^.-:%d+: ", ""):sub(1, 120)
        entry = nil
      end
      self.cache[name] = entry
      step()
    end
    if entry then
      for k, e in pairs(entry.keys) do
        snap[k] = e.value
        meta[k] = e
      end
    end
  end
  snap.localTime = date("%Y-%m-%d %H:%M")
  put(snap, "serverTime", function() return string.format("%02d:%02d", GetGameTime()) end)
  return snap, meta, errors
end

-- Everything at once (for /ia datos and tests).
function Collect:Snapshot()
  local snap, _, errs = self:Gather()
  -- Why a section is missing (read by the companion's log, not by the AI).
  if next(errs) then snap.diagnostics = errs end
  return snap
end