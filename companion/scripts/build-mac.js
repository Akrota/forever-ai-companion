// Builds the macOS app: dist/mac/Forever AI Companion.app, and the zip that
// is published: dist/ForeverAICompanion-mac.zip.
//
//   npm run build          (on a Mac)
//
// The bundle:
//   Contents/MacOS/ForeverAICompanion          native part (macos/App.swift): menu bar
//                                              icon, window, dialogs, screen reader
//   Contents/MacOS/ForeverAICompanionService   the app itself: a Node single executable
//                                              application (the same code as on Windows)
//   Contents/PlugIns/ForeverAICompanionVoice.appex   the silent voice (macos/Voice.swift)
//
// Needs Xcode's command line tools (swiftc, lipo, codesign) and Node 22+.
// Options (environment variables):
//   FAIC_MAC_ARCHS       "arm64,x64" (default: a universal app) or just one
//   FAIC_SIGN_IDENTITY   a "Developer ID Application: …" identity; default "-"
//                        (ad-hoc: players confirm the first opening in System Settings)
//   FAIC_NOTARY_PROFILE  notarytool keychain profile: notarizes and staples the app
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inject } from 'postject';
import { ROOT } from '../src/config.js';
import { bundleApp } from './bundle.js';

const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'mac');
const WORK = path.join(OUT, 'work');
const CACHE = path.join(DIST, 'cache');
const APP = path.join(OUT, 'Forever AI Companion.app');
const ZIP = path.join(DIST, 'ForeverAICompanion-mac.zip');
const SRC = path.join(ROOT, 'macos');
const VERSION = fs.readFileSync(path.join(ROOT, 'src', 'app', 'controller.js'), 'utf8').match(/VERSION = '([\d.]+)'/)[1];
const ARCHS = (process.env.FAIC_MAC_ARCHS || 'arm64,x64').split(',').map((a) => a.trim()).filter(Boolean);
const IDENTITY = process.env.FAIC_SIGN_IDENTITY || '-';
const NOTARY = process.env.FAIC_NOTARY_PROFILE || '';
const MIN_MACOS = '13.0';

const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });
const swiftArch = (a) => (a === 'x64' ? 'x86_64' : 'arm64');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

console.log(`Forever AI Companion ${VERSION} for macOS (${ARCHS.join(' + ')})`);

// 1. The app's code in one file, then the SEA blob Node runs.
console.log('1/7 Bundling the code…');
const bundle = path.join(WORK, 'forever-ai-companion.cjs');
await bundleApp(bundle);
const blob = path.join(WORK, 'sea-prep.blob');
const seaConfig = path.join(WORK, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false,
}));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 2. A Node binary per architecture, same version as this one. The other
// architecture's comes from nodejs.org, checked against its SHASUMS256.
async function nodeBinary(arch) {
  if (arch === process.arch) return process.execPath;
  const ver = process.version;
  const name = `node-${ver}-darwin-${arch}`;
  const cached = path.join(CACHE, name, 'bin', 'node');
  if (fs.existsSync(cached)) return cached;
  console.log(`   downloading Node ${ver} for ${arch}…`);
  const base = `https://nodejs.org/dist/${ver}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = new RegExp(`^([0-9a-f]{64})\\s+${name}\\.tar\\.gz$`, 'm').exec(sums)?.[1];
  if (!want) throw new Error(`no checksum for ${name}`);
  const res = await fetch(`${base}/${name}.tar.gz`);
  if (!res.ok) throw new Error(`Node download: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('Node download: SHA-256 mismatch');
  const tgz = path.join(CACHE, `${name}.tar.gz`);
  fs.writeFileSync(tgz, buf);
  run('/usr/bin/tar', ['-xzf', tgz, '-C', CACHE]);
  fs.rmSync(tgz);
  return cached;
}

console.log('2/7 Creating the service (Node single executable)…');
const services = [];
for (const arch of ARCHS) {
  const bin = path.join(WORK, `service-${arch}`);
  fs.copyFileSync(await nodeBinary(arch), bin);
  fs.chmodSync(bin, 0o755);
  run('/usr/bin/codesign', ['--remove-signature', bin]);
  await inject(bin, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA',
  });
  services.push(bin);
}

// 3. The native part and the silent voice, per architecture.
console.log('3/7 Compiling the native app and the silent voice (Swift)…');
const apps = [];
const voices = [];
for (const arch of ARCHS) {
  const target = `${swiftArch(arch)}-apple-macos${MIN_MACOS}`;
  const app = path.join(WORK, `app-${arch}`);
  run('swiftc', ['-O', '-target', target, '-o', app, path.join(SRC, 'App.swift')]);
  apps.push(app);
  const voice = path.join(WORK, `voice-${arch}`);
  // -parse-as-library: the extension's entry point is NSExtensionMain, so the
  // file's globals must be initialized lazily (not by a top-level main).
  run('swiftc', ['-O', '-target', target, '-module-name', 'ForeverAICompanionVoice', '-application-extension', '-parse-as-library',
    '-Xlinker', '-e', '-Xlinker', '_NSExtensionMain', '-o', voice, path.join(SRC, 'Voice.swift')]);
  voices.push(voice);
}

// 4. The bundle.
console.log('4/7 Assembling the app bundle…');
const contents = path.join(APP, 'Contents');
const appex = path.join(contents, 'PlugIns', 'ForeverAICompanionVoice.appex');
fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
fs.mkdirSync(path.join(appex, 'Contents', 'MacOS'), { recursive: true });
const lipo = (inputs, output) => {
  if (inputs.length === 1) fs.copyFileSync(inputs[0], output);
  else run('/usr/bin/lipo', ['-create', ...inputs, '-output', output]);
  fs.chmodSync(output, 0o755);
};
lipo(apps, path.join(contents, 'MacOS', 'ForeverAICompanion'));
lipo(services, path.join(contents, 'MacOS', 'ForeverAICompanionService'));
lipo(voices, path.join(appex, 'Contents', 'MacOS', 'ForeverAICompanionVoice'));
// Audio Unit versions are 0xMMmmbb (major, minor, bugfix).
const [maj, min, fix] = VERSION.split('.').map(Number);
const plist = (file) => fs.readFileSync(path.join(SRC, file), 'utf8')
  .replaceAll('__VERSION__', VERSION).replaceAll('__AUVERSION__', String(maj * 65536 + min * 256 + fix));
fs.writeFileSync(path.join(contents, 'Info.plist'), plist('Info.plist'));
fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
fs.writeFileSync(path.join(appex, 'Contents', 'Info.plist'), plist('VoiceInfo.plist'));

// 5. The icon, from the same artwork as the Windows one.
console.log('5/7 Making the icon…');
const iconset = path.join(WORK, 'AppIcon.iconset');
fs.mkdirSync(iconset);
const png = path.join(ROOT, 'assets', 'icon-256.png');
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale;
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
    run('/usr/bin/sips', ['-z', String(px), String(px), png, '--out', path.join(iconset, name)]);
  }
}
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources', 'AppIcon.icns')]);

// 6. Signing: inner code first, the app last. With a Developer ID the
// hardened runtime is on (Node needs JIT: service.entitlements).
console.log(`6/7 Signing (${IDENTITY === '-' ? 'ad-hoc' : IDENTITY})…`);
const signArgs = IDENTITY === '-' ? ['-f', '-s', '-'] : ['-f', '-s', IDENTITY, '--timestamp', '-o', 'runtime'];
run('/usr/bin/codesign', [...signArgs, '--entitlements', path.join(SRC, 'voice.entitlements'), appex]);
run('/usr/bin/codesign', [...signArgs, ...(IDENTITY === '-' ? [] : ['--entitlements', path.join(SRC, 'service.entitlements')]),
  path.join(contents, 'MacOS', 'ForeverAICompanionService')]);
run('/usr/bin/codesign', [...signArgs, APP]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP]);

// 7. The zip players download (and the app updates itself from).
console.log('7/7 Packing the zip…');
const zip = () => {
  fs.rmSync(ZIP, { force: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, ZIP]);
};
zip();
if (NOTARY) {
  console.log('   notarizing…');
  run('/usr/bin/xcrun', ['notarytool', 'submit', ZIP, '--keychain-profile', NOTARY, '--wait'], { stdio: 'inherit' });
  run('/usr/bin/xcrun', ['stapler', 'staple', APP], { stdio: 'inherit' });
  zip();
}
fs.rmSync(WORK, { recursive: true, force: true });

const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(1);
console.log(`Done: ${APP}\n      ${ZIP} (${mb(ZIP)} MB)`);
if (IDENTITY === '-') console.log('Ad-hoc signed: the first time, players open it from System Settings › Privacy & Security › "Open Anyway".');
