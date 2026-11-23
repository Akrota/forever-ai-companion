// English by default, Spanish for Spanish-speaking players, German for German-speaking ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { messagesFor, normalizeLang, runInLang, t } from '../src/i18n.js';
import { trayTexts } from '../src/tray.js';

test('languages: Spanish locales map to es, German to de, everything else to English', () => {
  for (const l of ['es', 'es-CL', 'es_MX', 'esES', 'ES-AR']) assert.equal(normalizeLang(l), 'es', l);
  for (const l of ['de', 'de-DE', 'de_DE', 'deDE', 'DE-AT']) assert.equal(normalizeLang(l), 'de', l);
  for (const l of ['en', 'en-US', 'enGB']) assert.equal(normalizeLang(l), 'en', l);
  for (const l of ['fr-FR', 'itIT', '', null]) assert.equal(normalizeLang(l), null, String(l));
});

test('every message exists in English, Spanish and German, with the same placeholders', () => {
  const en = messagesFor('en');
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const [lang, name] of [['es', 'Spanish'], ['de', 'German']]) {
    const msgs = messagesFor(lang);
    for (const key of Object.keys(en)) {
      assert.ok(msgs[key], `missing ${name}: ${key}`);
      assert.equal(vars(msgs[key]), vars(en[key]), `placeholders differ (${lang}): ${key}`);
    }
  }
  assert.equal(runInLang('en', () => t('tooSlow', { bin: 'codex' })), 'codex took too long to answer.');
  assert.equal(runInLang('es', () => t('tooSlow', { bin: 'codex' })), 'codex tardó demasiado en responder.');
  assert.equal(runInLang('de-DE', () => t('tooSlow', { bin: 'codex' })), 'codex hat zu lange für die Antwort gebraucht.');
  assert.equal(runInLang('fr', () => t('noSuchKey')), 'noSuchKey', 'unknown keys never crash');
});

test('the tray icon gets its texts in the app language', () => {
  const decode = (b64) => Object.fromEntries(Buffer.from(b64, 'base64').toString('utf8').split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const en = runInLang('en', () => decode(trayTexts()));
  assert.equal(en.keep, 'Keep running in the background');
  assert.match(en.askText, /\\n\\n/, 'line breaks travel escaped');
  const es = runInLang('es', () => decode(trayTexts()));
  assert.equal(es.quit, 'Cerrar la app');
  const de = runInLang('de', () => decode(trayTexts()));
  assert.equal(de.quit, 'App schließen');
});
