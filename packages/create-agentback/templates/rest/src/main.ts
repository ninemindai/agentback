import {installExplorer} from '@agentback/rest-explorer';
import {Application} from './application.js';

const app = new Application();
await installExplorer(app, {title: '{{name}}'});

await app.start();
const server = await app.restServer;
console.log(`{{name}} listening at ${server.url}`);
console.log(`  GET  ${server.url}/greet/hello/world`);
console.log(`  GET  ${server.url}/openapi.json`);
console.log(`  GET  ${server.url}/explorer/`);
