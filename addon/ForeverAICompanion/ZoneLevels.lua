-- Level range of every WoW Forever zone, for the proactive "new zone" tip.
-- { English name, Spanish name, lowest level to quest there, highest }.
-- From the Forever guide (companion/knowledge-builtin/wow-forever-topics.md):
-- the lowest level is the guides' "recommended minimum to quest", the highest
-- the top of the zone's creature levels, with outliers cut. Cities, instances
-- and zones with no range are left out: they never give a zone tip.
local _, ns = ...

local ZoneLevels = {}
ns.ZoneLevels = ZoneLevels

local ZONES = {
  -- Eastern Kingdoms
  { "Elwynn Forest", "Bosque de Elwynn", 1, 10 },
  { "Dun Morogh", "Dun Morogh", 1, 12 },
  { "Tirisfal Glades", "Claros de Tirisfal", 1, 12 },
  { "Westfall", "Páramos de Poniente", 10, 18 },
  { "Loch Modan", "Loch Modan", 10, 18 },
  { "Silverpine Forest", "Bosque de Argénteos", 10, 20 },
  { "Redridge Mountains", "Montañas Crestagrana", 15, 25 },
  { "Duskwood", "Bosque del Ocaso", 20, 30 },
  { "Wetlands", "Los Humedales", 20, 30 },
  { "Hillsbrad Foothills", "Laderas de Trabalomas", 20, 31 },
  { "Alterac Mountains", "Montañas de Alterac", 30, 39 },
  { "Arathi Highlands", "Tierras Altas de Arathi", 30, 40 },
  { "Stranglethorn Vale", "Vega de Tuercespina", 30, 50 },
  { "Badlands", "Tierras Inhóspitas", 35, 45 },
  { "Swamp of Sorrows", "Pantano de las Penas", 35, 43 },
  { "Riverglades", "Clarofluvial", 35, 44 },
  { "The Hinterlands", "Tierras del Interior", 40, 56 },
  { "Searing Gorge", "La Garganta de Fuego", 43, 56 },
  { "Blasted Lands", "Las Tierras Devastadas", 45, 60 },
  { "Western Plaguelands", "Tierras de la Peste del Oeste", 50, 57 },
  { "Burning Steppes", "Las Estepas Ardientes", 50, 59 },
  { "Eastern Plaguelands", "Tierras de la Peste del Este", 53, 59 },
  { "Deadwind Pass", "Paso de la Muerte", 55, 60 },
  -- Kalimdor
  { "Durotar", "Durotar", 1, 10 },
  { "Mulgore", "Mulgore", 1, 10 },
  { "Teldrassil", "Teldrassil", 1, 11 },
  { "Darkshore", "Costa Oscura", 10, 19 },
  { "The Barrens", "Los Baldíos", 10, 33 },
  { "Stonetalon Mountains", "Sierra Espolón", 15, 25 },
  { "Ashenvale", "Vallefresno", 18, 30 },
  { "Thousand Needles", "Las Mil Agujas", 25, 35 },
  { "Desolace", "Desolace", 30, 39 },
  { "Dustwallow Marsh", "Marjal Revolcafango", 35, 50 },
  { "Feralas", "Feralas", 35, 55 },
  { "Shen'dralas", "Shen'dralas", 40, 60 },
  { "Tanaris", "Tanaris", 40, 50 },
  { "Azshara", "Azshara", 45, 55 },
  { "Felwood", "Frondavil", 45, 54 },
  { "Un'Goro Crater", "Cráter de Un'Goro", 48, 55 },
  { "Winterspring", "Cuna del Invierno", 53, 60 },
  { "Silithus", "Silithus", 55, 59 },
  { "Mount Hyjal", "Monte Hyjal", 60, 60 },
  -- Island
  { "Zephras Isle", "Isla de Zephras", 1, 12 },
}

local byName = {}
for _, z in ipairs(ZONES) do
  local range = { min = z[3], max = z[4] }
  byName[z[1]:lower()] = range
  byName[z[2]:lower()] = range
end

-- { min, max } of a zone by name (English or Spanish), or nil if unknown.
function ZoneLevels:Range(name)
  if type(name) ~= "string" then return nil end
  local r = byName[name:lower()]
  return r and r.min, r and r.max
end

-- Whether a zone is worth a tip at this level: from two levels below its
-- lowest quest level up to its highest.
function ZoneLevels:Suits(name, level)
  local min, max = self:Range(name)
  if not min or not level then return false end
  return level >= min - 2 and level <= max
end
