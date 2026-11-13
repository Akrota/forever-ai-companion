-- Game -> companion transport.
-- Addons cannot use the network or write files on demand, so the request is
-- drawn for a fraction of a second as a thin strip of small, dark cells along
-- the top edge of the game window. The companion app reads that strip
-- straight from the screen (no screenshot, no hidden UI, no freeze).
--
-- Grid layout (cell coordinates, row r / column c, origin top-left):
--   row 0          : alternating white/black, starting white   (horizontal pitch)
--   column 0       : alternating white/black, starting white   (vertical pitch)
--   row 1, c=1..4  : gray levels 0,1,2,3                       (color calibration)
--   row 1, c=5,6   : grid width W  (two 6-bit symbols, high first)
--   row 1, c=7,8   : grid height H (two 6-bit symbols, high first)
--   rows 2..H-1, columns 1..W-1 : data symbols, row-major
-- Each cell holds one 6-bit symbol: 2 bits per R/G/B channel, 4 dark levels
-- (LEVELS below). "White" in the rulers is the brightest level.
-- Data bytes (all lengths big endian):
--   v1: "AZIA" | 1 | length(3) | payload | adler32(payload)(4)
--   v2: "AZIA" | 2 | compressedLength(3) | payloadLength(3) | LZW(payload) | adler32(payload)(4)
-- LZW: codes start at 9 bits and grow to 16; the dictionary stops at 65536 entries.
local _, ns = ...

local Uplink = {}
ns.Uplink = Uplink

Uplink.MAGIC = "AZIA"
Uplink.CELL_PX = 3      -- cell size in physical screen pixels
Uplink.MAX_COLS = 4095  -- limit of the 12-bit width field
Uplink.MAX_SCREEN_FRACTION = 0.25
Uplink.SHOW_SECONDS = 0.35 -- how long the strip stays on screen
Uplink.SHOW_FRAMES = 6     -- ...and at least this many frames

-- Dark levels: the strip reads as a brief dark line, not a colorful block.
local LEVELS = { 0, 40 / 255, 80 / 255, 120 / 255 }
local floor, ceil, min = math.floor, math.ceil, math.min

local function bigEndian(n, bytes)
  local out = {}
  for i = bytes, 1, -1 do
    out[i] = string.char(n % 256)
    n = floor(n / 256)
  end
  return table.concat(out)
end

-- `step`, where accepted, is called every so often during long loops so the
-- caller can pause and continue on the next frame (see Core: no freezes).
function Uplink.Adler32(s, step)
  local a, b = 1, 0
  for i = 1, #s do
    a = (a + s:byte(i)) % 65521
    b = (b + a) % 65521
    if step and i % 4096 == 0 then step() end
  end
  return b * 65536 + a
end

function Uplink.Compress(s, step)
  local dict, nextCode, width = {}, 256, 9
  for i = 0, 255 do dict[string.char(i)] = i end
  local out, acc, nbits = {}, 0, 0
  local function emit(code)
    acc = acc * 2 ^ width + code
    nbits = nbits + width
    while nbits >= 8 do
      nbits = nbits - 8
      local byte = floor(acc / 2 ^ nbits)
      out[#out + 1] = string.char(byte)
      acc = acc - byte * 2 ^ nbits
    end
  end
  local w = ""
  for i = 1, #s do
    local c = s:sub(i, i)
    local wc = w .. c
    if dict[wc] then
      w = wc
    else
      emit(dict[w])
      if nextCode < 65536 then
        dict[wc] = nextCode
        nextCode = nextCode + 1
        if nextCode > 2 ^ width and width < 16 then width = width + 1 end
      end
      w = c
    end
    if step and i % 1024 == 0 then step() end
  end
  if w ~= "" then emit(dict[w]) end
  if nbits > 0 then out[#out + 1] = string.char(acc * 2 ^ (8 - nbits)) end
  return table.concat(out)
end

-- The bytes drawn on screen. Compressed when that makes them smaller.
function Uplink.Frame(payload, step)
  local checksum = bigEndian(Uplink.Adler32(payload, step), 4)
  local compressed = Uplink.Compress(payload, step)
  if #compressed + 3 < #payload then
    return Uplink.MAGIC .. string.char(2) .. bigEndian(#compressed, 3) .. bigEndian(#payload, 3)
      .. compressed .. checksum
  end
  return Uplink.MAGIC .. string.char(1) .. bigEndian(#payload, 3) .. payload .. checksum
end

-- 3 bytes -> 4 symbols of 6 bits (the last group is zero-padded).
function Uplink.ToSymbols(bytes)
  local out = {}
  for i = 1, #bytes, 3 do
    local b1, b2, b3 = bytes:byte(i, i + 2)
    local n = b1 * 65536 + (b2 or 0) * 256 + (b3 or 0)
    out[#out + 1] = floor(n / 262144) % 64
    out[#out + 1] = floor(n / 4096) % 64
    out[#out + 1] = floor(n / 64) % 64
    out[#out + 1] = n % 64
  end
  return out
end

local function gridSize(frameLen, maxCols)
  local W = min(maxCols, Uplink.MAX_COLS)
  local symbols = ceil(frameLen / 3) * 4
  local H = 2 + ceil(symbols / (W - 1))
  return W, H
end

-- Returns W, H and a flat array of symbols: cells[r * W + c + 1].
-- `frame` is the output of Uplink.Frame().
function Uplink.BuildGrid(frame, maxCols, step)
  local symbols = Uplink.ToSymbols(frame)
  local W, H = gridSize(#frame, maxCols)
  local dataCols = W - 1
  local cells = {}
  for r = 0, H - 1 do
    if step then step() end
    for c = 0, W - 1 do
      local v
      if r == 0 then
        v = (c % 2 == 0) and 63 or 0
      elseif c == 0 then
        v = (r % 2 == 0) and 63 or 0
      elseif r == 1 then
        if c == 5 then v = floor(W / 64) % 64
        elseif c == 6 then v = W % 64
        elseif c == 7 then v = floor(H / 64) % 64
        elseif c == 8 then v = H % 64
        else
          local level = (c - 1) % 4
          v = level * 21 -- same level on R, G and B
        end
      else
        v = symbols[(r - 2) * dataCols + c] or 0
      end
      cells[r * W + c + 1] = v
    end
  end
  return W, H, cells
end

local function physicalSize()
  if GetPhysicalScreenSize then
    local w, h = GetPhysicalScreenSize()
    if w and h and w > 0 and h > 0 then return w, h end
  end
  local res = GetCVar("gxWindowedResolution") or GetCVar("gxFullscreenResolution") or ""
  local w, h = res:match("(%d+)x(%d+)")
  return tonumber(w) or 1920, tonumber(h) or 1080
end

-- Besides fitting on screen, keep the grid to a size the game draws reliably
-- in a couple of frames (each colored cell is one texture).
Uplink.MAX_FRAME_BYTES = 7000

function Uplink:Fits(frameLen)
  if frameLen > self.MAX_FRAME_BYTES then return false end
  local physW, physH = physicalSize()
  local _, H = gridSize(frameLen, floor(physW / self.CELL_PX))
  return H * self.CELL_PX <= physH * self.MAX_SCREEN_FRACTION
end

-- The strip goes above the whole interface (UIParent child, highest strata),
-- so no window can cover it and nothing has to be hidden. With the interface
-- hidden (Alt+Z) it is attached to WorldFrame instead.
--
-- Every cell has its own texture (index r * W + c + 1). Textures are created
-- in the background after login (Warmup) and positioned once; a question only
-- changes their colors, a few hundred per frame while the strip is hidden, and
-- then shows the finished strip (Prepare + Reveal). Nothing heavy happens in
-- a single frame, so the game does not stutter.
function Uplink:Init()
  if self.grid then return end
  local grid = CreateFrame("Frame", nil, UIParent)
  grid:SetFrameStrata("TOOLTIP")
  grid:SetFrameLevel(9000)
  if grid.SetToplevel then grid:SetToplevel(true) end
  grid:Hide()
  self.grid = grid
  self.textures = {}
  self.shownCount = 0
  self.driver = CreateFrame("Frame")
  self.warmDriver = CreateFrame("Frame")
end

local function geometry(self)
  local physW, physH = physicalSize()
  local parent = UIParent:IsShown() and UIParent or WorldFrame
  local W = min(floor(physW / self.CELL_PX), self.MAX_COLS)
  local unit = self.CELL_PX * parent:GetHeight() / physH
  return parent, W, unit, physH
end

function Uplink:ApplyParent(parent)
  local grid = self.grid
  if grid:GetParent() ~= parent then
    grid:SetParent(parent)
    grid:SetFrameStrata("TOOLTIP")
    grid:SetFrameLevel(9000)
  end
end

local function place(grid, tex, i, W, unit)
  local r, c = floor((i - 1) / W), (i - 1) % W
  tex:ClearAllPoints()
  tex:SetPoint("TOPLEFT", grid, "TOPLEFT", c * unit, -r * unit)
  tex:SetSize(unit, unit)
end

-- Re-positions existing textures if the width or UI scale changed.
function Uplink:EnsureLayout(parent, W, unit, step)
  local layout = W .. ":" .. string.format("%.5f", unit)
  if self.layout == layout then return end
  self.layout = layout
  self.grid:ClearAllPoints()
  self.grid:SetPoint("TOPLEFT", parent, "TOPLEFT", 0, 0)
  for i, tex in ipairs(self.textures) do
    place(self.grid, tex, i, W, unit)
    if step and i % 500 == 0 then step() end
  end
end

function Uplink:EnsureTextures(count, W, unit, step)
  for i = #self.textures + 1, count do
    local tex = self.grid:CreateTexture(nil, "OVERLAY")
    place(self.grid, tex, i, W, unit)
    tex:Hide()
    self.textures[i] = tex
    if step and i % 300 == 0 then step() end
  end
end

-- Creates the textures for the biggest possible strip in the background,
-- 300 per frame, so the first question does not have to.
function Uplink:Warmup()
  self:Init()
  local parent, W, unit = geometry(self)
  self:ApplyParent(parent)
  self:EnsureLayout(parent, W, unit)
  local _, H = gridSize(self.MAX_FRAME_BYTES, W)
  local target = W * H
  local layout = self.layout
  self.warmDriver:SetScript("OnUpdate", function(f)
    if Uplink.preparing or Uplink.busy then return end
    local from = #Uplink.textures + 1
    if from > target or Uplink.layout ~= layout then
      f:SetScript("OnUpdate", nil)
      return
    end
    Uplink:EnsureTextures(min(target, from + 299), W, unit)
  end)
end

-- Builds the strip for `frame` (from Uplink.Frame) while it is hidden.
-- step() is called regularly so the work can span several frames.
function Uplink:Prepare(frame, step)
  self:Init()
  local parent, maxCols, unit, physH = geometry(self)
  local W, H, cells = Uplink.BuildGrid(frame, maxCols, step)
  if H * self.CELL_PX > physH * self.MAX_SCREEN_FRACTION then
    return false, "La pregunta y los datos no caben en la pantalla."
  end
  self.preparing = true
  local grid = self.grid
  grid:Hide()
  self:ApplyParent(parent)
  self:EnsureLayout(parent, W, unit, step)
  local count = W * H
  self:EnsureTextures(count, W, unit, step)
  grid:SetSize(W * unit, H * unit)
  for i = 1, count do
    local tex = self.textures[i]
    local v = cells[i]
    tex:SetColorTexture(LEVELS[floor(v / 16) % 4 + 1], LEVELS[floor(v / 4) % 4 + 1], LEVELS[v % 4 + 1], 1)
    tex:Show()
    if step and i % 1000 == 0 then step() end
  end
  for i = count + 1, self.shownCount do self.textures[i]:Hide() end
  self.shownCount = count
  self.preparing = false
  self.last = { bytes = #frame, cols = W, rows = H }
  return true
end

-- Shows the prepared strip for a moment. callback(true) runs once it is gone.
function Uplink:Reveal(callback)
  self.busy, self.callback = true, callback
  self.grid:Show()
  local frames = 0
  local shownAt = GetTime()
  self.driver:SetScript("OnUpdate", function()
    frames = frames + 1
    if frames >= Uplink.SHOW_FRAMES and GetTime() - shownAt >= Uplink.SHOW_SECONDS then
      Uplink.last.shownFrames = frames
      Uplink:Finish(true)
    end
  end)
end

-- Prepare + Reveal in one go (no frame spreading).
function Uplink:Send(frame, callback)
  if self.busy or self.preparing then return false, "Ya hay un envío en curso." end
  local ok, err = self:Prepare(frame)
  if not ok then return false, err end
  self:Reveal(callback)
  return true
end

function Uplink:Finish(success)
  self.driver:SetScript("OnUpdate", nil)
  self.grid:Hide()
  self.busy = false
  local cb = self.callback
  self.callback = nil
  if cb then cb(success) end
end