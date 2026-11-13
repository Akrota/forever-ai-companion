// Invisible voice channel: the addon's base64 + chunking (real Lua) and the
// app's reassembly must round-trip a request exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLua } from './helpers.js';
import { createAssembler } from '../src/voice-inbox.js';
import { machineRegFile, machineUnregFile, VOICE_NAME } from '../src/tts-voice.js';

test('Lua base64 matches the standard encoding', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'hola ñandú {"x":1}', '\u0000ÿ\u0010binario']) {
    const out = runLua('RESULT = ns.Voice.Base64(S)', { S: s }, ['Voice.lua']);
    assert.equal(out, Buffer.from(s, 'utf8').toString('base64'), JSON.stringify(s));
  }
});

test('a request spoken in chunks by the addon is reassembled by the app', () => {
  const out = runLua(`
    SPOKEN = {}
    C_VoiceChat = {
      GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft Zira Desktop - English (United States)" },
                                         { voiceID = 3, name = "AzerothIA - English (United States)" } } end,
      SpeakText = function(id, text, rate, volume, overlap)
        assert(id == 3, "wrong voice"); assert(overlap == true, "must queue"); assert(volume == 0, "must be silent")
        SPOKEN[#SPOKEN + 1] = text
      end,
    }
    assert(ns.Voice:Available())
    local parts = {}
    for i = 1, 400 do parts[i] = '{"quest":"Misión ' .. i .. ' ñ","n":' .. i .. '}' end
    local json = '{"id":"v1","question":"¿Me oyes?","context":{"quests":[' .. table.concat(parts, ",") .. ']}}'
    local frame = ns.Uplink.Frame(json)
    -- A typical request fits in one silent phrase with the default settings.
    assert(ns.Voice:Send(frame, "v0"))
    assert(#SPOKEN == 1, "expected a single phrase, got " .. #SPOKEN)
    SPOKEN = {}
    -- Small chunks to exercise multi-part reassembly.
    ns.Voice.CHUNK = 1000
    assert(ns.Voice:Send(frame, "v1"))
    RESULT = json .. "\\0" .. table.concat(SPOKEN, "\\0")
  `, {}, ['Json.lua', 'Uplink.lua', 'Voice.lua']);
  const [json, ...spoken] = out.split('\0');
  assert.ok(spoken.length > 1, 'should be split in several messages');
  for (const s of spoken) assert.ok(s.length <= 1000 + 20);
  const asm = createAssembler();
  // Arrival order does not matter; foreign texts are ignored.
  assert.equal(asm.add('Hola, esto lo lee el chat'), null);
  let payload = null;
  for (const s of [...spoken].reverse()) payload = asm.add(s) || payload;
  assert.ok(payload);
  assert.equal(payload.toString('utf8'), json);
});

test('messages wrapped in the game\'s "Start"/"End" bookmarks still reassemble', () => {
  const out = runLua(`
    SPOKEN = {}
    C_VoiceChat = {
      GetTtsVoices = function() return { { voiceID = 3, name = "AzerothIA - English (United States)" } } end,
      SpeakText = function(id, text) SPOKEN[#SPOKEN + 1] = text end,
    }
    assert(ns.Voice:Available())
    local json = '{"id":"w1","question":"' .. string.rep("¿Gnomeregan? ", 300) .. '"}'
    assert(ns.Voice:Send(ns.Uplink.Frame(json), "w1"))
    RESULT = json .. "\\0" .. table.concat(SPOKEN, "\\0")
  `, {}, ['Json.lua', 'Uplink.lua', 'Voice.lua']);
  const [json, ...spoken] = out.split('\0');
  const asm = createAssembler();
  let payload = null;
  // Exactly what the app logged from WoW: "Start" before, "End" after.
  for (const s of spoken) payload = asm.add(`Start${s}End`) || payload;
  assert.ok(payload);
  assert.equal(payload.toString('utf8'), json);
});

test('without the AzerothIA voice the addon falls back to the strip', () => {
  const out = runLua(`
    C_VoiceChat = { GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft Zira Desktop" } } end }
    RESULT = tostring(ns.Voice:Available())
  `, {}, ['Voice.lua']);
  assert.equal(out, 'false');
});

test('the voice is called ForeverAICompanion; the old "AzerothIA" one is replaced', () => {
  assert.equal(VOICE_NAME, 'ForeverAICompanion');
  const reg = machineRegFile('C:\\x\\AzerothIATts.dll');
  assert.match(reg, /\[-HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\AzerothIA\]/, 'installing removes the old token');
  assert.match(reg, /\[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\ForeverAICompanion\]/);
  assert.match(reg, /"Name"="ForeverAICompanion"/);
  const unreg = machineUnregFile();
  assert.match(unreg, /Tokens\\ForeverAICompanion\]/);
  assert.match(unreg, /Tokens\\AzerothIA\]/, 'uninstalling also removes the old name');

  // The addon prefers the new voice and still works with the old one.
  const pick = (names) => runLua(`
    C_VoiceChat = { GetTtsVoices = function() local l = {} for i, n in ipairs(NAMES) do l[i] = { voiceID = i, name = n } end return l end }
    RESULT = tostring(ns.Voice:Find())`, {}, ['Voice.lua'], `NAMES = { ${names.map((n) => JSON.stringify(n)).join(', ')} }`);
  assert.equal(pick(['Microsoft Zira', 'AzerothIA - English', 'ForeverAICompanion - English']), '3');
  assert.equal(pick(['Microsoft Zira', 'AzerothIA - English']), '2');
  assert.equal(pick(['Microsoft Zira']), 'nil');
});