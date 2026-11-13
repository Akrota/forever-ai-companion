import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Folder of the companion source (dev mode). In the packaged app this is unused.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADDON_SRC = path.resolve(ROOT, '..', 'addon', 'AzerothIA');
export const ADDON_NAME = 'AzerothIA';

// Where config.json, state.json, knowledge/ and logs live.
// Dev: the companion folder. Packaged app: %APPDATA%\AzerothIA (see app/main.js).
export const env = { dataDir: ROOT };

// Published guide: the same file as knowledge-builtin/wow-forever.md, read from
// the project's public repository. Editing it there updates every player.
export const GUIDE_URL = 'https://raw.githubusercontent.com/lucasmenares/forever-ai-companion/main/companion/knowledge-builtin/wow-forever.md';

export const DEFAULTS = {
  // Carpeta de WoW Forever (la que contiene Interface/ y Screenshots/).
  // null = autodetectar. También se puede usar la variable AZIA_WOW_DIR.
  wowDir: null,

  // "anthropic" | "openai" | "claude-code" | "codex" | "echo"
  provider: 'echo',

  anthropic: {
    model: 'claude-opus-5-5',
    effort: 'low',
    maxTokens: 2000,
    apiKey: null, // null = usa ANTHROPIC_API_KEY
    fallbacks: true,
  },
  // Cualquier API compatible con OpenAI: OpenAI, Gemini, Ollama, LM Studio, OpenRouter...
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    apiKey: null, // null = usa la variable de apiKeyEnv
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  // model: "sonnet" | "opus" | "haiku" | "default" (the plan's default) or a full model id.
  claudeCode: { bin: 'claude', model: 'sonnet', effort: 'low', extraArgs: [] },
  // Codex CLI with a ChatGPT Plus / Pro plan. model: "default" (the plan's) or a slug.
  codex: { bin: 'codex', model: 'default', effort: 'low', extraArgs: [] },

  // Set by the app window: "claude" | "chatgpt" | "gemini" | "ollama" | "claude-code" | "codex" | "echo".
  // When set, it overrides provider/anthropic/openai above (see PRESETS).
  preset: null,
  keys: {},
  models: {},

  slots: 50,
  signals: 500,
  pollMs: 1000,
  keepAnswers: 30,
  timeoutMs: 180000,

  // Let the AI search the web when it needs to (Claude, Codex).
  webSearch: true,

  // Where the up-to-date WoW Forever guide is published (see src/guide.js).
  // The app downloads it every few hours; null = only the guide inside the app.
  guideUrl: GUIDE_URL,

  // Closing the app window: "ask" | "tray" (keep running next to the clock) | "quit".
  closeAction: 'ask',
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export const configFile = () => path.join(env.dataDir, 'config.json');

export function readUserConfig(file = configFile()) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`config.json no es JSON válido: ${e.message}`);
  }
}

// Simple choices shown in the app window. Each maps onto a provider config.
// The user's keys and models are stored per preset in `keys` / `models`.
export const PRESETS = {
  claude: { provider: 'anthropic', model: 'claude-opus-5-5', needsKey: true },
  chatgpt: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', needsKey: true },
  gemini: { provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needsKey: true },
  ollama: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', needsKey: false },
  'claude-code': { provider: 'claude-code', model: 'sonnet', needsKey: false },
  codex: { provider: 'codex', model: 'default', needsKey: false },
  echo: { provider: 'echo', needsKey: false },
};

export function applyPreset(cfg) {
  const p = PRESETS[cfg.preset];
  if (!p) return cfg;
  const key = cfg.keys?.[cfg.preset] || null;
  const model = cfg.models?.[cfg.preset] || p.model;
  cfg.provider = p.provider;
  if (p.provider === 'anthropic') {
    cfg.anthropic = { ...cfg.anthropic, apiKey: key, model };
  } else if (p.provider === 'openai') {
    cfg.openai = { ...cfg.openai, baseUrl: p.baseUrl, model, apiKey: key, apiKeyEnv: null };
  } else if (p.provider === 'claude-code') {
    cfg.claudeCode = { ...cfg.claudeCode, model };
  } else if (p.provider === 'codex') {
    cfg.codex = { ...cfg.codex, model };
  }
  return cfg;
}

export function loadConfig(file = configFile()) {
  const cfg = applyPreset(merge(DEFAULTS, readUserConfig(file)));
  if (process.env.AZIA_WOW_DIR) cfg.wowDir = process.env.AZIA_WOW_DIR;
  if (process.env.AZIA_PROVIDER) cfg.provider = process.env.AZIA_PROVIDER;
  return cfg;
}

// Merges `patch` into the saved user config (only what the user changed is stored).
export function saveConfig(patch, file = configFile()) {
  const next = merge(readUserConfig(file), patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return loadConfig(file);
}

function candidateDirs() {
  const out = [];
  if (process.platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F']) {
      for (const base of ['Program Files (x86)', 'Program Files', '', 'Games', 'Juegos']) {
        out.push(path.join(`${drive}:\\`, base, 'World of Warcraft', '_forever_'));
      }
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/World of Warcraft/_forever_');
  }
  return out;
}

export function resolveWowDir(cfg) {
  if (cfg.wowDir) {
    if (!fs.existsSync(cfg.wowDir)) throw new Error(`No existe la carpeta de WoW configurada: ${cfg.wowDir}`);
    return cfg.wowDir;
  }
  const found = candidateDirs().find((d) => fs.existsSync(d));
  if (!found) {
    throw new Error(
      'No encontré la carpeta de WoW Forever. Pon "wowDir" en config.json ' +
      '(la carpeta _forever_ que contiene Interface y Screenshots).',
    );
  }
  return found;
}

export function wowPaths(wowDir) {
  const addons = path.join(wowDir, 'Interface', 'AddOns');
  const addonDir = path.join(addons, ADDON_NAME);
  const pad = (n, w) => String(n).padStart(w, '0');
  return {
    wowDir,
    addons,
    addonDir,
    screenshots: path.join(wowDir, 'Screenshots'),
    sigDir: path.join(addonDir, 'sig'),
    okSignal: path.join(addonDir, 'sig', 'ok.wav'),
    signal: (i) => path.join(addonDir, 'sig', `${pad(i, 3)}.wav`),
    slotName: (i) => `${ADDON_NAME}_S${pad(i, 2)}`,
    slotDir: (i) => path.join(addons, `${ADDON_NAME}_S${pad(i, 2)}`),
  };
}
