// Updating from inside the app: only newer, published, verified versions.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSET_NAME, REPO, compareVersions, createUpdater, parseRelease } from '../src/updater.js';

const exeBytes = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const release = (version, over = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/${REPO}/releases/tag/v${version}`,
  assets: [{
    name: ASSET_NAME,
    size: exeBytes.length,
    digest: `sha256:${sha(exeBytes)}`,
    browser_download_url: `https://github.com/${REPO}/releases/download/v${version}/${ASSET_NAME}`,
  }],
  ...over,
});

// GitHub stand-in: the releases API and the download.
function fakeGitHub({ latest, file = exeBytes }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('api.github.com')) return new Response(JSON.stringify(latest()), { status: 200 });
    return new Response(file, { status: 200, headers: { 'content-length': String(file.length) } });
  };
  return { fetchImpl, calls };
}

test('versions compare numerically', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('v1.7.0', '1.6.0') > 0);
  assert.equal(compareVersions('1.6.0', 'v1.6'), 0);
  assert.ok(compareVersions('1.6.0', '1.6.1') < 0);
});

test('only a published release from this project, with the exe, is trusted', () => {
  assert.equal(parseRelease(release('1.7.0')).sha256, sha(exeBytes));
  assert.equal(parseRelease(release('1.7.0', { prerelease: true })), null, 'no pre-releases');
  assert.equal(parseRelease(release('1.7.0', { draft: true })), null);
  const elsewhere = release('1.7.0');
  elsewhere.assets[0].browser_download_url = `https://evil.example/${ASSET_NAME}`;
  assert.equal(parseRelease(elsewhere), null, 'downloads only from this repository');
  const otherRepo = release('1.7.0');
  otherRepo.assets[0].browser_download_url = `https://github.com/someone/fork/releases/download/v1.7.0/${ASSET_NAME}`;
  assert.equal(parseRelease(otherRepo), null);
  assert.equal(parseRelease(release('1.7.0', { assets: [] })), null, 'no exe, no update');
});

test('a newer version is offered once, downloaded and verified', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ForeverAICompanion-1.5.0.exe'), 'old download'); // cleaned at start
  let latest = release('1.6.0');
  const gh = fakeGitHub({ latest: () => latest });
  const announced = [];
  const u = createUpdater({ currentVersion: '1.6.0', dir, fetchImpl: gh.fetchImpl, intervalMs: 1e9, onAvailable: (v) => announced.push(v) });
  t.after(() => u.stop());
  assert.deepEqual(fs.readdirSync(dir), [], 'old downloads removed');

  assert.equal((await u.check()).status, 'latest');
  latest = release('1.7.0');
  const s = await u.check();
  assert.equal(s.status, 'available');
  assert.equal(s.latest, '1.7.0');
  await u.check();
  assert.deepEqual(announced, ['1.7.0'], 'the notice is shown once per version');

  const file = await u.download();
  assert.equal(sha(fs.readFileSync(file)), sha(exeBytes));
  assert.equal(u.state().status, 'ready');
  assert.equal(u.state().progress, 100);
  assert.equal(await u.download(), file, 'not downloaded twice');
});

test('a download that does not match what GitHub published is thrown away', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, why] of [
    [Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]), /SHA-256/],
    [exeBytes.subarray(0, 100), /incomplete/],
  ]) {
    const gh = fakeGitHub({ latest: () => release('1.7.0'), file });
    const u = createUpdater({ currentVersion: '1.6.0', dir, fetchImpl: gh.fetchImpl, intervalMs: 1e9 });
    await u.check();
    await assert.rejects(u.download(), why);
    assert.equal(u.state().status, 'available', 'can try again');
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing left behind');
    u.stop();
  }
  // Same size and no published digest, but not a Windows program.
  const notExe = Buffer.alloc(exeBytes.length, 0x41);
  const noDigest = release('1.7.0');
  delete noDigest.assets[0].digest;
  const gh = fakeGitHub({ latest: () => noDigest, file: notExe });
  const u = createUpdater({ currentVersion: '1.6.0', dir, fetchImpl: gh.fetchImpl, intervalMs: 1e9 });
  await u.check();
  await assert.rejects(u.download(), /not a Windows program/);
  u.stop();
});

test('no internet: it says so and keeps working', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faic-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const u = createUpdater({ currentVersion: '1.6.0', dir, intervalMs: 1e9, fetchImpl: async () => { throw new Error('offline'); } });
  const s = await u.check();
  assert.equal(s.status, 'error');
  assert.match(s.error, /offline/);
  u.stop();
});
