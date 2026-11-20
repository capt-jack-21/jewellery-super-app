import { readFileSync } from 'node:fs';
const en = JSON.parse(readFileSync('src/i18n/messages/en-IN.json', 'utf8'));
const ta = JSON.parse(readFileSync('src/i18n/messages/ta-IN.json', 'utf8'));
const missing = Object.keys(en).filter((k) => !(k in ta));
const extra = Object.keys(ta).filter((k) => !(k in en));
if (missing.length || extra.length) { console.error({ missing, extra }); process.exit(1); }
console.log(`i18n: OK (${Object.keys(en).length} keys, en-IN + ta-IN)`);
