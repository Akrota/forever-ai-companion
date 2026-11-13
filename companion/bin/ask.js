// Test the AI configuration without the game:
//   npm run ask -- "¿Qué mazmorra me recomiendas?"
// Uses sample/contexto-ejemplo.json as the character.
import { loadConfig } from '../src/config.js';
import { sampleContext } from '../src/assets.js';
import { buildMessages, buildSystem, cleanAnswer, loadKnowledge } from '../src/prompt.js';
import { ask } from '../src/providers.js';

const question = process.argv.slice(2).join(' ') || '¿Cuál es la mejor mazmorra que puedo hacer ahora?';
const cfg = loadConfig();
const req = { id: 'test', question, context: sampleContext(), history: [] };

console.log(`Proveedor: ${cfg.provider}\nPregunta: ${question}\n`);
try {
  const { text, model } = await ask(cfg, buildSystem(loadKnowledge()), buildMessages(req), req);
  console.log(`[${model}]\n${cleanAnswer(text)}`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
