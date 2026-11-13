// Developer mode: npm run install-addon [-- --wow "C:\...\_forever_"]
import { loadConfig, resolveWowDir, saveConfig } from '../src/config.js';
import { normalizeWowDir } from '../src/detect.js';
import { install } from '../src/install.js';

try {
  let cfg = loadConfig();
  const args = process.argv.slice(2);
  const i = args.indexOf('--wow');
  if (i >= 0 && args[i + 1]) {
    const dir = normalizeWowDir(args[i + 1]);
    if (!dir) throw new Error(`No encontré WoW Forever en ${args[i + 1]}`);
    cfg = saveConfig({ wowDir: dir }); // remember it for `npm start`
  }
  install(cfg, { wowDir: resolveWowDir(cfg) });
  console.log('IMPORTANTE: cierra WoW por completo y vuelve a abrirlo (un /reload no basta).');
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
