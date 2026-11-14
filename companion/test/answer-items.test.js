// Items in the AI's answers: {{item:ID|Name}} marks, made into links in the game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem, cleanAnswer, plainAnswer } from '../src/prompt.js';

test('the AI is told to mark items it saw in the data, never invented ones', () => {
  const system = buildSystem('', 'fizzi', { lang: 'es' });
  assert.match(system, /\{\{item:ITEMID\|Name\}\}/);
  assert.match(system, /Never make up or guess an id/);
});

test('item marks survive the answer cleanup and read as [Name] outside the game', () => {
  const answer = cleanAnswer('**Equípate** {{item:9999|Anillo del alba}} y vende {{item:858|Poción de sanación inferior}}.');
  assert.equal(answer, 'Equípate {{item:9999|Anillo del alba}} y vende {{item:858|Poción de sanación inferior}}.');
  assert.equal(plainAnswer(answer), 'Equípate [Anillo del alba] y vende [Poción de sanación inferior].');
  assert.equal(plainAnswer('sin objetos {llaves}'), 'sin objetos {llaves}');
});
