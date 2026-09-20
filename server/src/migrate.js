import { loadConfig } from './config.js';
import { createDb } from './db.js';

const config = loadConfig();
const db = createDb(config.databasePath);
console.log(`migrations ok: ${config.databasePath}`);
console.log(
  'applied:',
  db.all('SELECT name, applied_at FROM schema_migrations ORDER BY id')
    .map((r) => `${r.name}@${r.applied_at}`)
    .join(', '),
);
db.close();
