// Runs Collect.lua against a fake WoW API (modern C_Container / C_Item style
// plus a classic ammo slot) and checks the snapshot the AI would receive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLua } from './helpers.js';

const FAKE_WOW = `
  local items = {
    [2519] = { "Virote pesado", 1, 15, 15, "Proyectil", "Virote", 200, "INVTYPE_AMMO" },
    [4306] = { "Paño de seda", 1, 15, 0, "Comercio", "Tela", 20, "" },
    [858]  = { "Poción de sanación inferior", 1, 5, 1, "Consumible", "Poción", 5, "" },
    [9999] = { "Leotardos de cuero", 2, 25, 20, "Armadura", "Cuero", 1, "INVTYPE_LEGS" },
    [3000] = { "Repetidora de púas sepulcral", 2, 30, 25, "Arma", "Ballesta", 1, "INVTYPE_RANGEDRIGHT" },
  }
  local function link(id) return "|cffffffff|Hitem:" .. id .. "::::::::33:::::|h[" .. items[id][1] .. "]|h|r" end
  -- bag -> slot -> { id, count }
  local bagContents = {
    [0] = { { 4306, 20 }, { 858, 5 }, { 4306, 7 } },
    [1] = { { 9999, 1 }, { 2519, 200 }, { 2519, 200 } },
  }
  NUM_TOTAL_EQUIPPED_BAG_SLOTS = 4
  C_Container = {
    GetContainerNumSlots = function(bag) return bagContents[bag] and #bagContents[bag] + 2 or 0 end,
    GetContainerNumFreeSlots = function(bag) return bagContents[bag] and 2 or 0 end,
    GetContainerItemInfo = function(bag, slot)
      local s = bagContents[bag] and bagContents[bag][slot]
      if not s then return nil end
      return { hyperlink = link(s[1]), stackCount = s[2] }
    end,
  }
  C_Item = {
    GetItemInfo = function(l)
      local id = tonumber(l:match("item:(%d+)"))
      local it = items[id]
      if not it then return nil end
      return it[1], l, it[2], it[3], it[4], it[5], it[6], it[7], it[8]
    end,
  }
  GetInventoryItemLink = function(unit, slot)
    if slot == 0 then return link(2519) end
    if slot == 18 then return link(3000) end
    return nil
  end
  GetInventoryItemCount = function(unit, slot) return slot == 0 and 183 or 0 end
  GetInventoryItemDurability = function() return 40, 50 end
  C_Item.GetItemStats = function(l)
    if l:find("item:3000") then return { ITEM_MOD_AGILITY_SHORT = 4, ITEM_MOD_DAMAGE_PER_SECOND_SHORT = 14.27 } end
    return {}
  end
  GetTime = function() return 1000 end
  local units = { player = { "Sharp", 33, 820, 1000 }, pet = { "Garra", 32, 500, 500 } }
  UnitName = function(u) return units[u] and units[u][1] end
  UnitLevel = function(u) return units[u] and units[u][2] end
  UnitExists = function(u) return units[u] ~= nil end
  UnitHealth = function(u) return units[u] and units[u][3] end
  UnitHealthMax = function(u) return units[u] and units[u][4] end
  UnitCreatureFamily = function() return "Felino" end
  GetPetHappiness = function() return 3, 125, 2 end
  UnitClass = function() return "Cazadora", "HUNTER" end
  GetBindLocation = function() return "Forjaz" end
  C_UnitAuras = { GetAuraDataByIndex = function(u, i, f)
    if f == "HELPFUL" and i == 1 then return { name = "Bien alimentado", applications = 0, expirationTime = 1600 } end
  end }
  C_QuestLog = {
    GetNumQuestLogEntries = function() return 2 end,
    GetInfo = function(i)
      if i == 1 then return { isHeader = true, title = "Gnomeregan" } end
      return { title = "Excavadoras gyroagujereamáticas", level = 30, questID = 2928 }
    end,
    GetQuestObjectives = function() return { { text = "Entrañas robomecánicas: 0/24", finished = false } } end,
    GetQuestTagInfo = function() return { tagName = "Mazmorra" } end,
    GetNextWaypointText = function() return "Ve a Gnomeregan" end,
  }
  GetQuestLogQuestText = function(i) return "desc", "Consigue 24 Entrañas robomecánicas." end
  GetQuestLogRewardXP = function() return 3100 end
  GetQuestLogRewardMoney = function() return 12500 end
  GetNumQuestLogChoices = function() return 1 end
  GetQuestLogItemLink = function(kind, i, id) return kind == "choice" and link(9999) or nil end
  date = os.date
`;

test('snapshot includes bag contents grouped with counts, and ammo', () => {
  const json = runLua(
    'RESULT = ns.Json.Encode(ns.Collect:Snapshot())',
    {},
    ['Json.lua', 'Collect.lua'],
    FAKE_WOW,
  );
  const snap = JSON.parse(json);
  assert.deepEqual(snap.ammo, { name: 'Virote pesado', equipped: 183 });

  const inv = Object.fromEntries(snap.inventory.map((i) => [i.name, i]));
  assert.equal(inv['Paño de seda'].count, 27);          // two stacks merged
  assert.equal(inv['Virote pesado'].count, 400);
  assert.equal(inv['Poción de sanación inferior'].count, 5);
  assert.equal(inv['Leotardos de cuero'].equipSlot, 'INVTYPE_LEGS');
  assert.equal(inv['Leotardos de cuero'].itemLevel, 25);
  assert.equal(inv['Paño de seda'].equipSlot, undefined);
  assert.deepEqual(snap.bags, { freeSlots: 4, totalSlots: 10 });

  assert.equal(snap.gear.length, 1);
  assert.equal(snap.gear[0].name, 'Repetidora de púas sepulcral');
  assert.equal(snap.gear[0].durabilityPct, 80);
  assert.deepEqual(snap.gear[0].stats, { AGILITY: 4, DAMAGE_PER_SECOND: 14.3 });
  assert.equal(snap.lowestDurabilityPct, 80);

  assert.deepEqual(snap.pet, { name: 'Garra', level: 32, family: 'Felino', healthPct: 100, happiness: 'happy', damagePct: 125, loyaltyRate: 2 });
  assert.deepEqual(snap.buffs, [{ name: 'Bien alimentado', minutesLeft: 10 }]);

  const q = snap.quests[0];
  assert.equal(q.zone, 'Gnomeregan');
  assert.equal(q.tag, 'Mazmorra');
  assert.equal(q.goal, 'Consigue 24 Entrañas robomecánicas.');
  assert.equal(q.nextStep, 'Ve a Gnomeregan');
  assert.equal(q.rewardXp, 3100);
  assert.equal(q.rewardMoney, '1g 25s 0c');
  assert.equal(q.rewardChoices[0].name, 'Leotardos de cuero');
  assert.deepEqual(q.objectives, ['[ ] Entrañas robomecánicas: 0/24']);

  // Fields this fake client lacks (UnitRace...) are just left out.
  assert.equal(snap.character.name, 'Sharp');
  assert.equal(snap.character.race, undefined);
});

test('secret values (Midnight) never drop the character or the pet', () => {
  const secretWow = `${FAKE_WOW}
    SECRET = setmetatable({}, { __tostring = function() return "secret" end })
    issecretvalue = function(v) return v == SECRET end
    UnitHealth = function() return SECRET end
    UnitHealthMax = function() return SECRET end
    UnitRace = function() return "Enana" end
    UnitXP = function() return 5120 end
    UnitXPMax = function() return 13600 end
    GetMoney = function() return 43712 end
    UnitAttackPower = function() return SECRET, 0, 0 end
    UnitRangedAttackPower = function() return 152, 10, 0 end
    GetCritChance = function() error("this API is broken here") end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], secretWow));
  assert.equal(snap.character.name, 'Sharp');
  assert.equal(snap.character.race, 'Enana');
  assert.equal(snap.character.xpPct, 38);
  assert.equal(snap.character.money, '4g 37s 12c');
  assert.equal(snap.character.healthPct, undefined);
  assert.equal(snap.pet.name, 'Garra');
  assert.equal(snap.pet.happiness, 'happy');
  assert.equal(snap.pet.healthPct, undefined);
  assert.equal(snap.stats.rangedAttackPower, 162);
  assert.equal(snap.stats.attackPower, undefined);
  assert.equal(snap.stats.critPct, undefined);
  // Only APIs this fake client really lacks show up as section errors.
  assert.deepEqual(Object.keys(snap.diagnostics).sort(), ['client', 'position']);
});

test('JSON encoder turns values it cannot read into null instead of failing', () => {
  const json = runLua(`
    local broken = setmetatable({}, { __len = function() error("secret value") end })
    local weird = setmetatable({}, { __pairs = function() error("secret table") end })
    issecretvalue = function(v) return v == "SECRET" end
    RESULT = ns.Json.Encode({ a = 1, b = broken, c = "ok", d = weird, e = "SECRET", f = { 1, 2 } })
  `, {}, ['Json.lua']);
  // `weird` looks empty to next(), so it is encoded as an empty list: also fine.
  assert.deepEqual(JSON.parse(json), { a: 1, b: null, c: 'ok', d: [], e: null, f: [1, 2] });
});

test('a section that fails is reported in diagnostics', () => {
  const broken = `${FAKE_WOW}
    C_Container.GetContainerItemInfo = function() error("boom") end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], broken));
  assert.equal(snap.inventory, undefined);
  assert.match(snap.diagnostics.inventory, /boom/);
});

test('quests carry the game map coordinates; items, race and lockouts are included', () => {
  const extra = `
    C_QuestLog.GetNextWaypoint = function(id) return 1426, 0.244, 0.391 end
    C_QuestLog.GetQuestsOnMap = function(map) if map == 1426 then return { { questID = 2928, x = 0.512, y = 0.633 } } end return {} end
    GetQuestUiMapID = function() return 1426 end
    C_Map = { GetMapInfo = function(id) return id == 1426 and { name = "Dun Morogh" } or nil end }
    UnitRace = function() return "Cielonata de la Suma Orden", "Skyborne" end
    GetNumSavedInstances = function() return 2 end
    GetSavedInstanceInfo = function(i)
      if i == 1 then return "La Ciudad Anegada", 1, 7200, 1, true, false, 0, false, 5, "Normal" end
      return "Gnomeregan", 2, 0, 1, false, false, 0, false, 5, "Normal"
    end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  const q = snap.quests[0];
  assert.deepEqual(q.where, { zone: 'Dun Morogh', x: 51.2, y: 63.3 });
  assert.deepEqual(q.waypoint, { zone: 'Dun Morogh', x: 24.4, y: 39.1 });
  assert.equal(q.rewardChoices[0].itemId, 9999, 'item id, to look it up in English');
  assert.equal(snap.gear[0].itemId, 3000);
  assert.equal(snap.character.raceToken, 'Skyborne');
  assert.deepEqual(snap.lockouts, [{ name: 'La Ciudad Anegada', players: 5, difficulty: 'Normal', resetHours: 2 }]);
});
// --- Linked items, open windows and recipes ------------------------------------

test('items linked in the question come with stats and the slots they replace', () => {
  const out = runLua(`
    local q = "Is " .. "|cff1eff00|Hitem:3000::::::::33:::::|h[Repetidora]|h|r" .. " better than "
      .. "|cff1eff00|Hitem:9999::::::::33:::::|h[Leotardos]|h|r" .. "? Or |cff71d5ff|Hspell:3044|h[Disparo arcano]|h|r"
    RESULT = ns.Json.Encode(ns.Collect:Links(q)) .. "#" .. ns.Collect.Clean(q)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW);
  const [json, clean] = out.split('#');
  const links = JSON.parse(json);
  assert.equal(links.length, 3);
  assert.equal(links[0].name, 'Repetidora de púas sepulcral');
  assert.deepEqual(links[0].slots, ['ranged']);
  assert.equal(links[0].stats.AGILITY, 4);
  assert.deepEqual(links[1].slots, ['legs']);
  assert.deepEqual(links[2], { kind: 'spell', name: 'Disparo arcano', id: 3044 });
  assert.equal(clean, 'Is [Repetidora] better than [Leotardos]? Or [Disparo arcano]');
});

test('links colored the newer way ("|cnIQ1:") are cleaned too', () => {
  // Exactly what WoW Forever put in the question box.
  const out = runLua(`
    local q = "que es esto? |cnIQ1:|Hitem:4306::::::::33:::::|h[Simple Wood]|h|r"
    local links = ns.Collect:Links(q)
    RESULT = ns.Collect.Clean(q) .. "#" .. links[1].name .. "#" .. tostring(links[1].itemId)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW);
  assert.equal(out, 'que es esto? [Simple Wood]#Paño de seda#4306');
});

test('open windows: vendor with prices and repair, quest reward choices; nothing when closed', () => {
  const extra = `
    GetMerchantNumItems = function() return 2 end
    GetMerchantItemInfo = function(i)
      if i == 1 then return "Repetidora de púas sepulcral", 0, 12345, 1, -1, true, true, false end
      return "Agua refrescante", 0, 25, 5, 3, true, true, false
    end
    GetMerchantItemLink = function(i) return i == 1 and "|Hitem:3000::::::::33:::::|h[x]|h" or nil end
    CanMerchantRepair = function() return true end
    GetRepairAllCost = function() return 5000 end
    GetTitleText = function() return "Excavadoras" end
    GetQuestID = function() return 2928 end
    GetRewardText = function() return "¡Gracias, |cffffff00amigo|r!" end
    GetRewardXP = function() return 3100 end
    GetRewardMoney = function() return 0 end
    GetNumQuestRewards = function() return 0 end
    GetNumQuestChoices = function() return 2 end
    GetQuestItemLink = function(kind, i) return i == 1 and "|Hitem:9999|h[a]|h" or "|Hitem:3000|h[b]|h" end
    GetQuestItemInfo = function(kind, i) return "x", 0, 1 end
  `;
  const out = runLua(`
    local closed = ns.Json.Encode(ns.Collect:Snapshot().screen or "none")
    ns.Collect.cache = {}
    ns.Collect.open.merchant = true
    ns.Collect.open.quest = "complete"
    RESULT = closed .. "#" .. ns.Json.Encode(ns.Collect:Snapshot().screen)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  const [closed, json] = out.split('#');
  assert.equal(closed, '"none"', 'nothing is sent while no window is open');
  const screen = JSON.parse(json);
  assert.equal(screen.merchant.items.length, 2);
  assert.equal(screen.merchant.items[0].price, '1g 23s 45c');
  assert.deepEqual(screen.merchant.items[0].slots, ['ranged']);
  assert.deepEqual(screen.merchant.items[1], { name: 'Agua refrescante', price: '0g 0s 25c', stack: 5, limited: 3 });
  assert.equal(screen.merchant.canRepair, true);
  assert.equal(screen.merchant.repairAllCost, '0g 50s 0c');
  assert.equal(screen.questReward.title, 'Excavadoras');
  assert.equal(screen.questReward.text, '¡Gracias, amigo!');
  assert.equal(screen.questReward.rewards.xp, 3100);
  assert.deepEqual(screen.questReward.rewards.choices.map((c) => c.slots[0]), ['legs', 'ranged']);
});

test('recipes of the open profession window, with skill-up color and reagents', () => {
  const extra = `
    GetTradeSkillLine = function() return "Herrería", 75, 150 end
    local lines = {
      { "Hojas", "header" },
      { "Espada de cobre", "optimal", 2, { { "Barra de cobre", 6 }, { "Piedra de afilar", 1 } } },
      { "Barra de cobre pulida", "trivial", 10 },
    }
    GetNumTradeSkills = function() return #lines end
    GetTradeSkillInfo = function(i) return lines[i][1], lines[i][2], lines[i][3] or 0 end
    GetTradeSkillNumReagents = function(i) return lines[i][4] and #lines[i][4] or 0 end
    GetTradeSkillReagentInfo = function(i, j) local r = lines[i][4][j]; return r[1], 0, r[2] end
  `;
  const json = runLua('RESULT = ns.Json.Encode(ns.Collect:Recipes())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  assert.deepEqual(JSON.parse(json), {
    profession: 'Herrería', rank: 75, max: 150,
    recipes: [
      { name: 'Espada de cobre', difficulty: 'orange', canMake: 2, reagents: '6x Barra de cobre, 1x Piedra de afilar' },
      { name: 'Barra de cobre pulida', difficulty: 'grey', canMake: 10 },
    ],
  });
});
