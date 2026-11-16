// macOS: installs a downloaded update (ForeverAICompanion-mac.zip, already
// checked against the SHA-256 GitHub publishes, see updater.js). The zip is
// unpacked, the app inside is checked (our bundle id, an intact signature),
// and once this app has quit it takes the place of this one and starts again
// in the background, keeping all data.
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config.js';
import { APP_BUNDLE, BUNDLE_ID, afterShellQuits, bundlePath, exec, installedBundle } from './app/system.js';

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export async function checkBundle(app) {
  const id = await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Contents', 'Info.plist')]);
  if (!id.ok || id.stdout.trim() !== BUNDLE_ID) throw new Error('the update is not Forever AI Companion');
  const sig = await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 120000 });
  if (!sig.ok) throw new Error(`the update's signature is not intact: ${sig.stderr.trim()}`);
}

export async function installMacUpdate(zip, { log = () => {} } = {}) {
  const staging = path.join(env.dataDir, 'update-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const unzip = await exec('/usr/bin/ditto', ['-x', '-k', zip, staging], { timeout: 300000 });
  if (!unzip.ok) throw new Error(`could not unpack the update: ${unzip.stderr.trim()}`);
  const app = path.join(staging, APP_BUNDLE);
  if (!fs.existsSync(app)) throw new Error('the update does not contain the app');
  await checkBundle(app);
  await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app]);
  const target = bundlePath() || installedBundle();
  log(`Update ready: it replaces ${target} when the app quits.`);
  afterShellQuits([
    'old="$2.old-$$"',
    'mv "$2" "$old" 2>/dev/null',
    'if mv "$1" "$2"; then rm -rf "$old"; else mv "$old" "$2"; fi',
    `"${LSREGISTER}" -f "$2" >/dev/null 2>&1`,
    '/usr/bin/open "$2" --args --background',
    'rm -rf "$3"',
  ].join('; '), [app, target, staging]);
}
