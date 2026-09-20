import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`server listening on http://${config.host}:${config.port}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
