// Entry point of ForeverAICompanion.exe (and of `npm run app` in development).
//
// Double-clicking the downloaded exe:
//   1. copies itself to %LOCALAPPDATA%\Programs\AzerothIA and creates Start
//      menu + desktop shortcuts (closing an older running version first);
//   2. starts the background service and opens the setup window.
// Running it again just reopens the window of the instance already running.
// `--background` (used by "start with Windows") starts without a window.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config.js';
import { createController, VERSION } from './controller.js';
import { createServer, findRunningInstance, listen, quitRunningInstance } from './server.js';
import * as sys from './system.js';
import { appIconIco, trayCsSource } from '../assets.js';
import { ensureTrayExe, startTray } from '../tray.js';

const args = process.argv.slice(2);
// --background: started with Windows, no window. --no-window: for testing.
const background = args.includes('--background') || args.includes('--no-window');

function makeLogger() {
  const file = path.join(env.dataDir, 'azerothia.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.old`);
  } catch { /* ignore */ }
  return (...parts) => {
    const line = `[${new Date().toLocaleString()}] ${parts.join(' ')}\n`;
    try { fs.appendFileSync(file, line); } catch { /* ignore */ }
    if (!sys.isPackaged()) process.stdout.write(line);
  };
}

async function selfInstall(log) {
  const target = sys.installedExe();
  if (sys.samePath(process.execPath, target)) return false;
  // Updating: close the version that is running from the install folder.
  const running = await findRunningInstance();
  if (running) await quitRunningInstance(running);
  fs.mkdirSync(sys.installDir(), { recursive: true });
  let lastError;
  for (let i = 0; i < 10; i++) {
    try {
      fs.copyFileSync(process.execPath, target);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (lastError) throw new Error(`No se pudo instalar en ${target}: ${lastError.message}`);
  await sys.createShortcuts(target).catch((e) => log(`No se pudieron crear accesos directos: ${e.message}`));
  log(`Instalado en ${target}`);
  sys.relaunch(target, args);
  return true;
}

async function main() {
  if (sys.isPackaged()) env.dataDir = sys.appDataDir();
  if (process.env.AZIA_DATA_DIR) env.dataDir = process.env.AZIA_DATA_DIR;
  fs.mkdirSync(env.dataDir, { recursive: true });
  const log = makeLogger();

  if (sys.isPackaged() && sys.isWindows && !args.includes('--no-install')) {
    if (await selfInstall(log)) process.exit(0);
  }

  const running = await findRunningInstance();
  if (running) {
    if (!background) sys.openWindow(running);
    process.exit(0);
  }

  // Coming from the app's first name (AzerothIA.exe): drop the old program
  // file and move "start with Windows" to the new name and exe.
  if (sys.isPackaged() && sys.isWindows && sys.samePath(process.execPath, sys.installedExe())) {
    try { fs.rmSync(sys.legacyExe(), { force: true }); } catch { /* still in use: next time */ }
    if (await sys.getAutostart()) await sys.setAutostart(true).catch((e) => log(`Inicio con Windows: ${e.message}`));
    // First run of a new version: fresh shortcuts so Windows shows the current icon.
    const marker = path.join(env.dataDir, 'installed-version');
    let seen = null;
    try { seen = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first run */ }
    if (seen !== VERSION) {
      await sys.createShortcuts(sys.installedExe()).catch((e) => log(`Accesos directos: ${e.message}`));
      try { fs.writeFileSync(marker, VERSION); } catch { /* ignore */ }
    }
  }

  const controller = createController({ log });
  let tray = null;
  const quit = () => {
    controller.stop();
    tray?.stop();
    log('Forever AI Companion cerrada.');
    setTimeout(() => process.exit(0), 150); // lets the tray icon go away first
  };
  // Closing the window: ask, keep running next to the clock, or quit.
  let remindedTray = false;
  const onWindowClosed = () => {
    if (!tray) return; // no tray icon: keep running as before
    const action = controller.closeAction();
    if (action === 'quit') return quit();
    if (action === 'tray') {
      if (!remindedTray) tray.balloon('Haz clic en este ícono para abrirla, o clic derecho para cerrarla.');
      remindedTray = true;
      return;
    }
    tray.ask();
  };
  const server = createServer(controller, { onQuit: quit, onWindowClosed, log });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/`;
  log(`Forever AI Companion ${background ? 'en segundo plano' : 'abierta'}: ${url}`);
  if (!background) sys.openWindow(url);

  // Icon next to the Windows clock.
  if (sys.isWindows && !args.includes('--no-tray')) {
    try {
      const ico = path.join(env.dataDir, 'app.ico');
      fs.writeFileSync(ico, appIconIco());
      const exe = await ensureTrayExe({ source: trayCsSource(), dir: sys.isPackaged() ? sys.installDir() : env.dataDir, icoPath: ico });
      tray = startTray({
        exe, icoPath: ico, log,
        onOpen: () => sys.openWindow(url),
        onQuit: quit,
        onChoice: (choice, remember) => {
          if (remember) { try { controller.setCloseAction({ action: choice }); } catch (e) { log(e.message); } }
          if (choice === 'quit') quit();
          else remindedTray = true;
        },
      });
      controller.setTrayReady(Boolean(tray));
    } catch (e) {
      log(`Ícono junto al reloj: ${e.message}`);
    }
  }
}

main().catch(async (e) => {
  try { fs.appendFileSync(path.join(env.dataDir, 'azerothia.log'), `[fatal] ${e.stack || e}\n`); } catch { /* ignore */ }
  if (sys.isPackaged()) await sys.showError(`Forever AI Companion no pudo iniciarse:\n\n${e.message}`);
  else console.error(e);
  process.exit(1);
});
