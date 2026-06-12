import {installExplorer} from '@agentback/rest-explorer';
import {installInspector} from '@agentback/mcp-inspector';
import {installMcpHttp} from '@agentback/mcp-http';
import {Application} from './application.js';

const app = new Application();
await installExplorer(app, {title: '{{name}} REST'});
await installInspector(app, {title: '{{name}} MCP'});
await installMcpHttp(app);

await app.start();
const server = await app.restServer;
console.log(`{{name}} listening at ${server.url}`);
console.log(`  GET  ${server.url}/greet/hello/world`);
console.log(`  GET  ${server.url}/openapi.json`);
console.log(`  GET  ${server.url}/explorer/`);
console.log(`  POST ${server.url}/mcp   (MCP Streamable HTTP)`);
console.log(`  GET  ${server.url}/mcp-inspector/`);
