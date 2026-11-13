// Developer mode: run the companion in the terminal (no window).
import { loadConfig, resolveWowDir } from '../src/config.js';
import { isAddonInstalled, installedAddonVersion, addonVersion, writeAddonFiles } from '../src/install.js';
import { addonFiles } from '../src/assets.js';
import { startWatcher } from '../src/watcher.js';
import { loadKnowledge } from '../src/prompt.js';

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

try {
  const cfg = loadConfig();
  const wowDir = resolveWowDir(cfg);
  if (!isAddonInstalled(wowDir, cfg)) {
    throw new Error('El addon no está instalado. Ejecuta primero: npm run install-addon');
  }
  const files = addonFiles();
  if (installedAddonVersion(wowDir) !== addonVersion(files['AzerothIA.toc'])) {
    writeAddonFiles(wowDir, files);
    log('Addon actualizado. Reinicia WoW para usar la versión nueva.');
  }
  const knowledge = loadKnowledge();
  log(`AzerothIA lista. Proveedor: ${cfg.provider}. WoW: ${wowDir}`);
  if (knowledge) log(`Conocimiento cargado: ${knowledge.length} caracteres.`);
  log('Esperando preguntas desde el juego... (Ctrl+C para salir)');
  startWatcher({ cfg, wowDir, log });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
