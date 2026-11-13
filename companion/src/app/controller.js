// The app's brain: owns the config, the watcher and the activity log, and
// implements every action the window can trigger.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PRESETS, env, loadConfig, saveConfig } from '../config.js';
import { findWowDirs, isWowRunning, normalizeWowDir } from '../detect.js';
import {
  addonVersion, install, installedAddonVersion, isAddonInstalled, uninstall as uninstallAddon, writeAddonFiles,
} from '../install.js';
import { addonFiles, knowledgeReadme, sampleContext } from '../assets.js';
import { buildMessages, buildSystem, cleanAnswer, loadKnowledge } from '../prompt.js';
import { ask, canSearch } from '../providers.js';
import { startWatcher } from '../watcher.js';
import { authStatus, findClaudeCode, openInstall, openLogin } from '../claude-code.js';
import { codexAuthStatus, findCodex, openCodexInstall, openCodexLogin } from '../codex.js';
import { ttsEngineSource } from '../assets.js';
import { compileEngine, installVoiceMachineWide, isLegacyVoiceVisible, isVoiceVisible, uninstallVoiceMachineWide } from '../tts-voice.js';
import * as sys from './system.js';
import { currentGuide, guideFreshness, startGuideUpdates } from '../guide.js';

export const VERSION = '1.5.0';

// Where the silent voice's DLL lives (it is loaded by the game while in use).
const voiceDll = () => path.join(sys.isPackaged() ? sys.installDir() : env.dataDir, 'AzerothIATts.dll');

export function createController({ log = () => {} } = {}) {
  let cfg = loadConfig();
  let watcher = null;
  let watcherError = null;
  let autostart; // cached: reading it spawns reg.exe
  let trayReady = false; // icon next to the Windows clock is running
  const events = [];
  const bundledVersion = addonVersion(addonFiles()['AzerothIA.toc']);

  const knowledgeDir = () => path.join(env.dataDir, 'knowledge');
  const ensureKnowledgeDir = () => {
    const dir = knowledgeDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'LEEME.md'), knowledgeReadme());
    }
  };
  ensureKnowledgeDir();

  // WoW Forever guide: the one inside the app or a newer downloaded one.
  const guideDir = path.join(env.dataDir, 'guide');
  let guide = currentGuide(guideDir);
  const guideUpdates = startGuideUpdates({
    url: cfg.guideUrl, dir: guideDir, log, onUpdate: () => { guide = currentGuide(guideDir); },
  });
  const guides = { current: () => guide, onPatch: () => guideUpdates.check('patch') };

  const wowDirValid = () => Boolean(cfg.wowDir && fs.existsSync(cfg.wowDir));
  const addonOk = () => wowDirValid() && isAddonInstalled(cfg.wowDir, cfg);

  function addEvent(e) {
    if (e.type === 'problem') {
      events.push({ id: `p${Date.now()}`, who: 'Forever AI Companion', question: '(pregunta ilegible)', ok: false, answer: e.message, pending: false, time: new Date().toISOString() });
      while (events.length > 20) events.shift();
      return;
    }
    if (e.type === 'answer') {
      const q = events.find((x) => x.id === e.id);
      if (q) Object.assign(q, { ok: e.ok, answer: e.answer, pending: false });
      return;
    }
    events.push({ ...e, pending: true, time: new Date().toISOString() });
    while (events.length > 20) events.shift();
  }

  function restartWatcher() {
    if (watcher) watcher.stop();
    watcher = null;
    watcherError = null;
    if (!wowDirValid()) { watcherError = 'Falta elegir la carpeta del juego.'; return; }
    if (!addonOk()) { watcherError = 'Falta instalar el addon.'; return; }
    try {
      // Keep the in-game addon up to date with this app's version.
      if (installedAddonVersion(cfg.wowDir) !== bundledVersion) {
        writeAddonFiles(cfg.wowDir);
        log(`Addon actualizado a ${bundledVersion}`);
      }
      watcher = startWatcher({ cfg, wowDir: cfg.wowDir, log, onEvent: addEvent, guides });
      log(`Esperando preguntas (${cfg.provider}) en ${cfg.wowDir}`);
    } catch (e) {
      watcherError = e.message;
      log(`No se pudo iniciar: ${e.message}`);
    }
  }

  function save(patch) {
    cfg = saveConfig(patch);
    restartWatcher();
  }

  // (Re)compiles the silent voice when its source changed (app updates).
  // Registration stays the same, so no administrator prompt is needed.
  async function refreshVoiceDll(force = false) {
    const dll = voiceDll();
    const source = ttsEngineSource();
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const hashFile = `${dll}.source-sha256`;
    const current = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8') : null;
    if (!force && current === hash && fs.existsSync(dll)) return dll;
    const src = path.join(env.dataDir, 'AzerothIATts.cs');
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(src, source);
    await compileEngine(src, dll);
    fs.writeFileSync(hashFile, hash);
    log('Voz invisible actualizada.');
    return dll;
  }
  if (sys.isWindows) {
    Promise.all([isVoiceVisible(), isLegacyVoiceVisible()])
      .then(([active, legacy]) => (active || legacy ? refreshVoiceDll() : null))
      .catch((e) => log(`No se pudo actualizar la voz invisible: ${e.message}`));
  }

  // First run: find the game on our own.
  if (!wowDirValid()) {
    const [found] = findWowDirs();
    if (found) {
      cfg = saveConfig({ wowDir: found });
      log(`WoW Forever encontrado en ${found}`);
    }
  }
  restartWatcher();

  const mask = (k) => (k ? `••••${String(k).slice(-4)}` : null);

  return {
    async status() {
      const preset = cfg.preset || (cfg.provider === 'echo' ? 'echo' : null);
      return {
        version: VERSION,
        packaged: sys.isPackaged(),
        wow: {
          dir: cfg.wowDir,
          valid: wowDirValid(),
          addonInstalled: addonOk(),
          addonVersion: wowDirValid() ? installedAddonVersion(cfg.wowDir) : null,
          bundledVersion,
        },
        ai: {
          preset,
          provider: cfg.provider,
          keys: Object.fromEntries(Object.keys(PRESETS).map((p) => [p, mask(cfg.keys?.[p])])),
          models: cfg.models || {},
          defaults: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.model || null])),
          webSearch: cfg.webSearch !== false,
        },
        running: Boolean(watcher),
        problem: watcherError,
        events: [...events].reverse(),
        autostart: autostart === undefined ? (autostart = await sys.getAutostart()) : autostart,
        closeAction: cfg.closeAction || 'ask',
        tray: trayReady,
        guide: guide ? {
          date: guide.meta.fecha,
          source: guide.source,
          age: guideFreshness(guide).age,
          stale: guideFreshness(guide).stale,
          autoUpdate: Boolean(cfg.guideUrl),
        } : null,
      };
    },

    async checkGuide() {
      const updated = await guideUpdates.check('manual');
      return { updated, date: guide?.meta.fecha || null };
    },

    setTrayReady(v) { trayReady = Boolean(v); },
    setWebSearch({ enabled }) {
      save({ webSearch: Boolean(enabled) });
      return { webSearch: Boolean(enabled) };
    },
    closeAction() { return cfg.closeAction || 'ask'; },
    setCloseAction({ action }) {
      if (!['ask', 'tray', 'quit'].includes(action)) throw new Error('Opción desconocida.');
      save({ closeAction: action });
      return { closeAction: action };
    },

    detectWow() {
      const dirs = findWowDirs();
      if (dirs[0]) save({ wowDir: dirs[0] });
      return { found: dirs };
    },

    async pickWow() {
      const chosen = await sys.pickFolder();
      if (!chosen) return { cancelled: true };
      const dir = normalizeWowDir(chosen);
      if (!dir) throw new Error('En esa carpeta no está WoW Forever. Elige la carpeta "World of Warcraft" o la carpeta "_forever_" que está dentro.');
      save({ wowDir: dir });
      return { dir };
    },

    installAddon() {
      if (!wowDirValid()) throw new Error('Primero elige la carpeta del juego.');
      install(cfg, { wowDir: cfg.wowDir, log });
      restartWatcher();
      return { wowRunning: isWowRunning() };
    },

    setAI({ preset, apiKey, model }) {
      if (!PRESETS[preset]) throw new Error('Opción de IA desconocida.');
      const patch = { preset };
      if (typeof apiKey === 'string' && apiKey.trim()) patch.keys = { [preset]: apiKey.trim() };
      if (typeof model === 'string') patch.models = { [preset]: model.trim() || null };
      if (PRESETS[preset].needsKey && !patch.keys && !cfg.keys?.[preset]) {
        throw new Error('Pega tu clave de API para esta opción.');
      }
      save(patch);
      return {};
    },

    async testAI() {
      const req = { id: 'test', question: '¿Qué mazmorra me recomiendas ahora? Responde en dos frases.', context: sampleContext(), history: [] };
      const started = Date.now();
      const system = buildSystem(loadKnowledge(), 'fizzi', { canSearch: canSearch(cfg), client: req.context?.client, ...(guide ? { guide } : {}) });
      const { text, model } = await ask(cfg, system, buildMessages(req), req);
      return { text: cleanAnswer(text), model, seconds: ((Date.now() - started) / 1000).toFixed(1) };
    },

    async voiceStatus() {
      if (!sys.isWindows) return { supported: false };
      const active = await isVoiceVisible();
      // Old name: it keeps working, but the window offers to rename it.
      const legacy = !active && await isLegacyVoiceVisible();
      return { supported: true, active: active || legacy, legacy, dll: fs.existsSync(voiceDll()) };
    },

    // Compiles the silent voice and registers it (one administrator prompt).
    async installVoice() {
      const dll = await refreshVoiceDll(true);
      await installVoiceMachineWide(dll, env.dataDir);
      log('Voz invisible activada.');
      return { active: await isVoiceVisible(), wowRunning: isWowRunning() };
    },

    async uninstallVoice() {
      await uninstallVoiceMachineWide(env.dataDir);
      log('Voz invisible desactivada.');
      return { active: await isVoiceVisible() };
    },

    async claudeStatus() {
      const found = findClaudeCode(cfg.claudeCode.bin);
      if (!found) return { installed: false, loggedIn: false };
      return { installed: true, source: found.source, ...(await authStatus(found.path)) };
    },

    claudeInstall() {
      openInstall();
      return {};
    },

    claudeLogin() {
      const found = findClaudeCode(cfg.claudeCode.bin);
      if (!found) throw new Error('Primero instala Claude Code.');
      openLogin(found.path);
      return {};
    },

    async codexStatus() {
      const found = findCodex(cfg.codex.bin);
      if (!found) return { installed: false, loggedIn: false };
      return { installed: true, source: found.source, ...(await codexAuthStatus(found.path)) };
    },

    codexInstall() {
      openCodexInstall();
      return {};
    },

    codexLogin() {
      const found = findCodex(cfg.codex.bin);
      if (!found) throw new Error('Primero instala Codex.');
      openCodexLogin(found.path);
      return {};
    },

    async setAutostart({ enabled }) {
      autostart = await sys.setAutostart(Boolean(enabled));
      return { autostart };
    },

    openKnowledge() {
      ensureKnowledgeDir();
      sys.openFolder(knowledgeDir());
      return {};
    },

    stop() {
      guideUpdates.stop();
      if (watcher) watcher.stop();
      watcher = null;
    },

    // Removes everything this app created. The caller then exits.
    async uninstall() {
      this.stop();
      if (wowDirValid()) uninstallAddon(cfg, cfg.wowDir);
      if (sys.isWindows) await uninstallVoiceMachineWide(env.dataDir).catch((e) => log(e.message));
      if (sys.isPackaged()) {
        await sys.setAutostart(false).catch(() => {});
        await sys.removeShortcuts().catch(() => {});
      }
      fs.rmSync(env.dataDir, { recursive: true, force: true });
      if (sys.isPackaged()) sys.scheduleSelfDelete(sys.installDir());
      return {};
    },
  };
}
