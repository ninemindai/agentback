import {installConsole} from '@agentback/console';
import {Application} from './application.js';

const app = new Application();
// Dev console at /console: DI context explorer + OpenAPI explorer in one shell.
// `unsafeAllowUnauthenticated` is for local development only — in production
// pass `auth` middleware instead (the console exposes DI internals).
await installConsole(app, {
  title: '{{name}}',
  unsafeAllowUnauthenticated: true,
});

await app.start();
const server = await app.restServer;
console.log(`{{name}} listening at ${server.url}`);
console.log(`  GET  ${server.url}/greet/hello/world`);
console.log(`  GET  ${server.url}/openapi.json`);
console.log(`  GET  ${server.url}/console/`);
