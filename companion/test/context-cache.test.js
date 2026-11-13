import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContext } from '../src/context-cache.js';

test('unchanged sections are filled in from the cache', () => {
  const cache = {};
  const first = {
    charKey: 'Sharp-Forever',
    context: { character: { name: 'Sharp' }, quests: [1, 2], localTime: 'x' },
    hashes: { character: 11, quests: 22 },
    same: {},
  };
  assert.deepEqual(resolveContext(first, cache), []);

  const second = {
    charKey: 'Sharp-Forever',
    context: { quests: [1, 2, 3], localTime: 'y' },
    hashes: { quests: 33 },
    same: { character: 11 },
  };
  assert.deepEqual(resolveContext(second, cache), []);
  assert.deepEqual(second.context.character, { name: 'Sharp' });
  assert.deepEqual(second.context.quests, [1, 2, 3]);
  assert.equal(cache['Sharp-Forever'].quests.hash, 33);
  assert.equal(cache['Sharp-Forever'].localTime, undefined, 'unhashed sections are not cached');
});

test('a section the cache does not have is reported as missing', () => {
  const cache = { 'Sharp-Forever': { character: { hash: 1, value: {} } } };
  const req = { charKey: 'Sharp-Forever', context: {}, hashes: {}, same: { character: 2, bank: 9 } };
  assert.deepEqual(resolveContext(req, cache).sort(), ['bank', 'character']);
  assert.equal(req.context.character, undefined);
});

test('characters do not mix', () => {
  const cache = {};
  resolveContext({ charKey: 'A-R', context: { stats: { a: 1 } }, hashes: { stats: 5 } }, cache);
  const req = { charKey: 'B-R', context: {}, same: { stats: 5 } };
  assert.deepEqual(resolveContext(req, cache), ['stats']);
});
