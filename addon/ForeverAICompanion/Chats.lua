-- Conversations, like the Claude / Codex apps: several chats, each with its
-- own messages. Only the current chat's earlier turns are sent to the AI.
-- Stored in ForeverAICompanion_DB.chats (account-wide).
local _, ns = ...
local L = ns.L

local Chats = {}
ns.Chats = Chats

Chats.MAX_CHATS = 60
Chats.MAX_MESSAGES = 120
Chats.DEFAULT_TITLE = L.NEW_CHAT
-- Empty chats created in either language still get their title from the first question.
local DEFAULT_TITLES = { [""] = true, ["New chat"] = true, ["Nuevo chat"] = true, [L.NEW_CHAT] = true }

local function newId()
  return string.format("c%d%04d", time(), math.random(0, 9999))
end

-- Short title from a question, without cutting a UTF-8 character in half.
local function titleFrom(text)
  text = (text or ""):gsub("%s+", " ")
  text = strtrim and strtrim(text) or text
  if #text <= 36 then return text end
  local cut = text:sub(1, 36):gsub("[\192-\255][\128-\191]*$", "")
  return cut .. "…"
end
Chats.TitleFrom = titleFrom

function Chats:Init()
  local db = ns.db
  db.chats = db.chats or {}
  -- Older versions kept one single history: keep it as a chat.
  if type(db.history) == "table" and #db.history > 0 then
    table.insert(db.chats, 1, {
      id = newId(),
      title = L.PREVIOUS_CONVERSATION,
      created = db.history[1].t or time(),
      updated = db.history[#db.history].t or time(),
      messages = db.history,
    })
  end
  db.history = nil
  if not self:Get(db.currentChat) then
    local all = self:All()
    db.currentChat = all[1] and all[1].id or nil
  end
end

function Chats:Get(id)
  if not id then return nil end
  for _, chat in ipairs(ns.db.chats) do
    if chat.id == id then return chat end
  end
end

-- Most recently used first.
function Chats:All()
  local list = {}
  for _, chat in ipairs(ns.db.chats) do list[#list + 1] = chat end
  table.sort(list, function(a, b) return (a.updated or 0) > (b.updated or 0) end)
  return list
end

-- The open chat; creates one if there is none.
function Chats:Current()
  return self:Get(ns.db.currentChat) or self:New()
end

local function hasPending(chat)
  for _, m in ipairs(chat.messages) do
    if m.status == "pending" then return true end
  end
  return false
end

-- Drops the oldest chat that is safe to lose: a past proactive tip first, then
-- any other chat that is not waiting for an answer. `keepId` and the open chat
-- are never dropped (a tip's chat is not the open one, see NewProactive).
function Chats:DropOldest(keepId)
  local victim
  for _, chat in ipairs(ns.db.chats) do
    if chat.id ~= keepId and chat.id ~= ns.db.currentChat and chat.proactive and not hasPending(chat) then
      victim = chat
      break
    end
  end
  if not victim then
    local all = self:All()
    for i = #all, 1, -1 do
      local chat = all[i]
      if chat.id ~= keepId and chat.id ~= ns.db.currentChat and not hasPending(chat) then victim = chat break end
    end
  end
  if not victim then return false end
  self:Delete(victim.id)
  return true
end

-- Opens a new empty chat (reuses the current one if it is still empty).
function Chats:New()
  local current = self:Get(ns.db.currentChat)
  if current and #current.messages == 0 and not current.proactive then return current end
  local chat = { id = newId(), title = self.DEFAULT_TITLE, created = time(), updated = time(), messages = {} }
  table.insert(ns.db.chats, chat)
  ns.db.currentChat = chat.id
  while #ns.db.chats > self.MAX_CHATS do
    if not self:DropOldest(chat.id) then break end
  end
  return chat
end

-- A fresh chat for one proactive tip. It does not become the open chat, so the
-- player's conversation stays put, and a later reply only carries this tip.
function Chats:NewProactive(question)
  local title = titleFrom(question or "")
  if title == "" then title = L.PROACTIVE_CHAT end
  local chat = {
    id = newId(), title = title, created = time(), updated = time(),
    messages = {}, proactive = true, renamed = true,
  }
  table.insert(ns.db.chats, chat)
  while #ns.db.chats > self.MAX_CHATS do
    if not self:DropOldest(chat.id) then break end
  end
  return chat
end

-- Removes a message by request id (a tip that failed or was dropped).
function Chats:RemoveEntry(id)
  for _, chat in ipairs(ns.db.chats) do
    for i, m in ipairs(chat.messages) do
      if m.id == id then
        table.remove(chat.messages, i)
        -- A tip that never got an answer should not leave an empty chat behind.
        if chat.proactive and #chat.messages == 0 and chat.id ~= ns.db.currentChat then
          self:Delete(chat.id)
        end
        return true
      end
    end
  end
end

function Chats:Select(id)
  local chat = self:Get(id)
  if chat then
    ns.db.currentChat = id
    chat.unread = nil
  end
  return chat
end

function Chats:Rename(id, title)
  local chat = self:Get(id)
  title = strtrim and strtrim(title or "") or (title or "")
  if chat and title ~= "" then
    chat.title = titleFrom(title)
    chat.renamed = true
  end
end

function Chats:Delete(id)
  for i, chat in ipairs(ns.db.chats) do
    if chat.id == id then
      table.remove(ns.db.chats, i)
      break
    end
  end
  if ns.db.currentChat == id then
    local all = self:All()
    ns.db.currentChat = all[1] and all[1].id or nil
  end
end

function Chats:AddMessage(chat, entry)
  table.insert(chat.messages, entry)
  if not chat.renamed and (chat.title == self.DEFAULT_TITLE or DEFAULT_TITLES[chat.title or ""]) then
    chat.title = titleFrom(entry.question)
  end
  chat.updated = time()
  while #chat.messages > self.MAX_MESSAGES do table.remove(chat.messages, 1) end
end

-- Finds a message by request id in any chat. Returns entry, chat.
function Chats:FindEntry(id)
  for _, chat in ipairs(ns.db.chats) do
    for _, m in ipairs(chat.messages) do
      if m.id == id then return m, chat end
    end
  end
end

-- fn(entry, chat) for every message of every chat.
function Chats:EachEntry(fn)
  for _, chat in ipairs(ns.db.chats) do
    for _, m in ipairs(chat.messages) do fn(m, chat) end
  end
end
