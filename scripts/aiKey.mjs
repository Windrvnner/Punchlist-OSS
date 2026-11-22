// Where the explicit live runs (scripts/live.mjs, scripts/ai-check.mjs) find the AI key: PUNCHLIST_AI_KEY, a file named
// in PUNCHLIST_AI_KEY_FILE, or the project's .env (git ignores it), which holds the Claude key: `envFile: false` leaves it
// out, so that key is never sent to another service. '' when there is none. It is never written anywhere.
import { readFileSync } from 'node:fs';
// .env in the project (ignored by git) holds the key: PUNCHLIST_AI_KEY=…
const fromEnvFile = () => { try { const m = /^PUNCHLIST_AI_KEY=(.*)$/m.exec(readFileSync(new URL('../.env', import.meta.url), 'utf8')); return m ? m[1].trim() : ''; } catch { return ''; } };
export const aiKey = ({ envFile = true } = {}) => process.env.PUNCHLIST_AI_KEY?.trim() || (process.env.PUNCHLIST_AI_KEY_FILE ? readFileSync(process.env.PUNCHLIST_AI_KEY_FILE, 'utf8').trim() : '') || (envFile ? fromEnvFile() : '');
