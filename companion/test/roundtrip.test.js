// End-to-end transport test: the real addon Lua builds the grid, we render it
// like a screenshot, and the companion decoder must recover the exact payload.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ADDON_SRC } from '../src/config.js';
import { decodeImage } from '../src/image.js';
import { GridUnreadableError, decodeGrid } from '../src/grid.js';

// Optional: a real in-game screenshot to check against (not committed).
const REAL_SHOT = process.env.FAIC_REAL_SHOT || '';
import { encodePNG, encodeTGA, luaSyntaxError, renderGrid, runLua } from './helpers.js';

const REQUEST_LUA = `
  local req = {
    v = 1, id = "17630000001234", sig = 7,
    question = '¿Cuál es la mejor mazmorra? "comillas" \\\\ barra | pipe\\nlínea 2',
    context = {
      character = { name = "Thoradin", level = 24, class = "Paladín", xp = 5120 },
      position = { zone = "Montañas de Alterac", x = 38.2, y = 46.75 },
      quests = { { title = "Las Minas", level = 18, objectives = { "[ ] VanCleef: 0/1" } } },
      gear = {},
    },
  }
  local json = ns.Json.Encode(req)
  local W, H, cells = ns.Uplink.BuildGrid(ns.Uplink.Frame(json), tonumber(MAXCOLS))
  RESULT = json .. "\\0" .. W .. "," .. H .. "," .. table.concat(cells, ",")
`;

function buildFromLua(maxCols = 320) {
  const out = runLua(REQUEST_LUA, { MAXCOLS: String(maxCols) });
  const [json, grid] = out.split('\0');
  const [W, H, ...cells] = grid.split(',').map(Number);
  return { json, W, H, cells };
}

test('every addon Lua file compiles', () => {
  for (const f of fs.readdirSync(ADDON_SRC).filter((n) => n.endsWith('.lua'))) {
    assert.equal(luaSyntaxError(fs.readFileSync(path.join(ADDON_SRC, f), 'utf8'), f), null, f);
  }
});

test('Lua JSON encoder produces valid JSON that preserves text', () => {
  const { json } = buildFromLua();
  const req = JSON.parse(json);
  assert.equal(req.id, '17630000001234');
  assert.equal(req.question, '¿Cuál es la mejor mazmorra? "comillas" \\ barra | pipe\nlínea 2');
  assert.equal(req.context.character.class, 'Paladín');
  assert.equal(req.context.position.zone, 'Montañas de Alterac');
  assert.equal(req.context.position.y, 46.75);
  assert.deepEqual(req.context.gear, []);
});

for (const { name, pitch, noise, fmt } of [
  { name: 'exact 6px cells, PNG', pitch: 6, noise: 0, fmt: 'png' },
  { name: 'fractional 6.4px cells + noise, PNG', pitch: 6.4, noise: 12, fmt: 'png' },
  { name: 'fractional 5.6px cells, TGA', pitch: 5.6, noise: 6, fmt: 'tga' },
  { name: 'large 9.37px cells (UI scale)', pitch: 9.37, noise: 8, fmt: 'png' },
]) {
  test(`grid round trip: ${name}`, () => {
    const { json, W, H, cells } = buildFromLua(240);
    const img = renderGrid(W, H, cells, { pitch, noise });
    const file = fmt === 'png' ? encodePNG(img) : encodeTGA(img);
    const decoded = decodeGrid(decodeImage(file, `WoWScrnShot_1.${fmt}`));
    assert.ok(decoded, 'grid not detected');
    assert.equal(decoded.toString('utf8'), json);
  });
}

for (const { name, pitch, noise, bg } of [
  { name: '3 px cells over a bright scene', pitch: 3, noise: 2, bg: 230 },
  { name: '3.33 px cells (fractional) over a dark scene', pitch: 10 / 3, noise: 3, bg: 10 },
  { name: '2.7 px cells', pitch: 2.7, noise: 0, bg: 120 },
]) {
  test(`dark thin strip: ${name}`, () => {
    // The addon sizes the strip to the window: floor(width / cell size) columns.
    const { json, W, H, cells } = buildFromLua(Math.floor(2560 / pitch));
    const img = renderGrid(W, H, cells, { pitch, noise, levels: [0, 40, 80, 120], width: 2560, height: 160 });
    // Paint the "game" behind the strip a uniform color to test both extremes.
    for (let y = Math.ceil(H * pitch); y < img.height; y++) img.data.fill(bg, y * img.width * 3, (y + 1) * img.width * 3);
    const decoded = decodeGrid(img);
    assert.ok(decoded, 'strip not detected');
    assert.equal(decoded.toString('utf8'), json);
  });
}

test('large request is LZW-compressed in Lua and recovered exactly (1920x1080)', () => {
  // ~30 KB of realistic, repetitive JSON: many quests and bag items.
  const out = runLua(`
    local quests, inv = {}, {}
    for i = 1, 25 do
      quests[i] = { title = "Misión número " .. i .. " de Vega de Tuercespina", level = 30 + (i % 8),
        zone = "Vega de Tuercespina", objectives = { "[ ] Raptor de Tuercespina: " .. i .. "/10" },
        goal = "Mata 10 raptores y vuelve con el explorador Doyle en el Campamento Rebelde.",
        rewardChoices = { { name = "Botas del cazador " .. i, quality = "uncommon", itemLevel = 34,
          stats = { AGILITY = 5, STAMINA = 4 } } } }
    end
    for i = 1, 70 do inv[i] = { name = "Objeto ñandú " .. i, count = i, quality = "common", type = "Varios" } end
    local json = ns.Json.Encode({ v = 1, id = "big1", sig = 3, question = "¿Qué hago ahora?",
      context = { quests = quests, inventory = inv } })
    local frame = ns.Uplink.Frame(json)
    local W, H, cells = ns.Uplink.BuildGrid(frame, 320)
    RESULT = json .. "\\0" .. #json .. "," .. #frame .. "," .. frame:byte(5) .. "\\0" .. W .. "," .. H .. "," .. table.concat(cells, ",")
  `);
  const [json, sizes, grid] = out.split('\0');
  const [jsonLen, frameLen, version] = sizes.split(',').map(Number);
  assert.equal(version, 2, 'should use the compressed frame');
  assert.ok(frameLen < jsonLen * 0.5, `compression too weak: ${frameLen}/${jsonLen}`);
  const [W, H, ...cells] = grid.split(',').map(Number);
  assert.ok(H * 6 <= 1080 * 0.8, `grid too tall for 1080p: ${H} rows`);
  const img = renderGrid(W, H, cells, { pitch: 6, noise: 4, width: 1920, height: 1080 });
  assert.equal(decodeGrid(decodeImage(encodePNG(img), 'x.png')).toString('utf8'), json);
});

test('a normal screenshot is not mistaken for a request', () => {
  const img = renderGrid(0, 0, [], { width: 400, height: 300 });
  assert.equal(decodeGrid(decodeImage(encodePNG(img), 'x.png')), null);
  const white = { width: 400, height: 300, channels: 3, data: Buffer.alloc(400 * 300 * 3, 255) };
  assert.equal(decodeGrid(white), null);
});

test('a corrupted grid is rejected by the checksum', () => {
  const { W, H, cells } = buildFromLua(240);
  const broken = cells.slice();
  broken[3 * W + 20] ^= 0b010101; // flip a data cell
  // The message follows the app's language (English or Spanish).
  assert.throws(() => decodeGrid(renderGrid(W, H, broken, { pitch: 6 })), /could not be read|no se pudo leer|konnte nicht gelesen werden/);
});

test('a grid partly covered by another window is reported, not ignored', () => {
  const { W, H, cells } = buildFromLua(240);
  const img = renderGrid(W, H, cells, { pitch: 6 });
  // Darken a "damage meter" window over the top-left, like a real player UI.
  for (let y = 4; y < 60; y++) {
    for (let x = 4; x < 300; x++) {
      const i = (y * img.width + x) * 3;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.round(img.data[i + c] * 0.35);
    }
  }
  assert.throws(() => decodeGrid(img), GridUnreadableError);
});

test('the real screenshot that failed in-game is reported as covered', { skip: !fs.existsSync(REAL_SHOT) }, () => {
  assert.throws(() => decodeGrid(decodeImage(fs.readFileSync(REAL_SHOT), 'x.png')), GridUnreadableError);
});
