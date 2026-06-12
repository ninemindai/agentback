import {installConsole} from '@agentback/console';
import {installMcpHttp} from '@agentback/mcp-http';
import {Application} from './application.js';

const app = new Application();
// Dev console at /console: DI context explorer + OpenAPI explorer + MCP
// inspector in one shell. `unsafeAllowUnauthenticated` is for local development
// only — in production pass `auth` middleware instead (the console exposes DI
// internals).
await installConsole(app, {
  title: '{{name}}',
  unsafeAllowUnauthenticated: true,
});
await installMcpHttp(app);

await app.start();
const server = await app.restServer;
console.log(`{{name}} listening at ${server.url}`);
console.log(`  GET  ${server.url}/greet/hello/world`);
console.log(`  GET  ${server.url}/openapi.json`);
console.log(`  POST ${server.url}/mcp   (MCP Streamable HTTP)`);
console.log(`  GET  ${server.url}/console/`);
