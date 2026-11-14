-- Minimal JSON encoder (WoW has none built in).
-- Defensive: any value that cannot be encoded (for example a Midnight
-- "secret value" that errors on comparison or string operations) becomes
-- null instead of breaking the whole document.
local _, ns = ...

local Json = {}
ns.Json = Json

local ESC = {
  ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
  ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encodeString(s)
  local out = s:gsub('[%c"\\]', function(c)
    return ESC[c] or string.format("\\u%04x", c:byte())
  end)
  return '"' .. out .. '"'
end

local function encodeNumber(n)
  if n ~= n or n == math.huge or n == -math.huge then return "null" end
  if n % 1 == 0 and n > -1e15 and n < 1e15 then return string.format("%d", n) end
  local s = string.format("%.2f", n)
  s = s:gsub("0+$", "")
  s = s:gsub("%.$", "")
  return s
end

local function isArray(t)
  local n = #t
  if n == 0 then return next(t) == nil end
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then return false end
  end
  return true
end

local function isSecret(v)
  if not issecretvalue then return false end
  local ok, secret = pcall(issecretvalue, v)
  return not ok or secret
end

local encode

local function encodeTable(t, depth)
  local parts = {}
  if isArray(t) then
    for i = 1, #t do parts[i] = encode(t[i], depth + 1) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for k in pairs(t) do
    if type(k) == "string" and not isSecret(k) then keys[#keys + 1] = k end
  end
  table.sort(keys)
  for _, k in ipairs(keys) do
    parts[#parts + 1] = encodeString(k) .. ":" .. encode(t[k], depth + 1)
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

encode = function(v, depth)
  if isSecret(v) then return "null" end
  local t = type(v)
  local fn
  if t == "nil" then return "null"
  elseif t == "boolean" then return v and "true" or "false"
  elseif t == "number" then fn = encodeNumber
  elseif t == "string" then fn = encodeString
  elseif t == "table" and depth <= 20 then
    local ok, out = pcall(encodeTable, v, depth)
    return ok and out or "null"
  else
    return "null"
  end
  local ok, out = pcall(fn, v)
  return ok and out or "null"
end

function Json.Encode(v)
  return encode(v, 0)
end

-- Adler-32 of a string (used to tell whether a section changed).
function Json.Hash(s)
  local a, b = 1, 0
  for i = 1, #s do
    a = (a + s:byte(i)) % 65521
    b = (b + a) % 65521
  end
  return b * 65536 + a
end
