import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../src/config.js';
import { probeReport, startProbeMonitor } from '../src/probe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('probe monitor sees which files the game wrote, and how fast', async () => {
  const wow = fs.mkdtempSync(path.join(os.tmpdir(), 'azia-probe-'));
  env.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azia-data-'));
  const charDir = path.join(wow, 'WTF', 'Account', 'ACC', 'Forever', 'Sharp');
  fs.mkdirSync(charDir, { recursive: true });
  fs.mkdirSync(path.join(wow, 'Logs'), { recursive: true });
  const config = path.join(wow, 'WTF', 'Config.wtf');
  const addons = path.join(charDir, 'AddOns.txt');
  const macros = path.join(wow, 'WTF', 'Account', 'ACC', 'macros-cache.txt');
  fs.writeFileSync(config, 'SET gxMaximize "1"\n');
  fs.writeFileSync(addons, 'AzerothIA: enabled\nAzerothIA_S50: enabled\n');
  fs.writeFileSync(macros, 'VER 3 0000 "OTRA" "INV"\nEND\n');

  const monitor = startProbeMonitor({ wowDir: wow, intervalMs: 50 });
  try {
    const t = Math.floor(Date.now() / 1000);
    // The "game" writes two of the channels right away; the macro never.
    fs.writeFileSync(config, 'SET gxMaximize "1"\nSET aziaProbe "AZIA-PROBE-1234"\n');
    fs.writeFileSync(addons, 'AzerothIA: enabled\nAzerothIA_S50: disabled\n');
    await sleep(300);
    const probe = {
      token: '1234',
      actions: { cvar: t, addons: t, macro: t, chat: t, tts: t },
      results: { cvar: 'ok', addons: 'ok', macro: 'ok', chat: 'no existe', tts: 'no existe' },
      ttsVoices: [],
      flashClientIcon: true,
    };
    const { text, report } = await probeReport(probe, monitor);
    assert.equal(report.channels.cvar.works, true);
    assert.equal(report.channels.addons.works, true);
    assert.equal(report.channels.macro.works, false);
    assert.equal(report.channels.chat.works, false);
    assert.ok(report.channels.cvar.seconds < 3);
    assert.match(text, /Config\.wtf\): SÍ/);
    assert.match(text, /macros-cache\.txt\): NO/);
    assert.ok(fs.existsSync(path.join(env.dataDir, 'probe-report.json')));

    // Real names reported by WoW Forever on the user's PC: classic (SAPI) voices.
    if (process.platform === 'win32') {
      const r2 = await probeReport({ ...probe, ttsVoices: [{ name: 'Microsoft Zira Desktop - English (United States)' }] }, monitor);
      if (r2.report.tts.windowsSapi.some((v) => /Zira Desktop/.test(v))) assert.equal(r2.report.tts.family, 'sapi');
    }
  } finally {
    monitor.stop();
  }
});
