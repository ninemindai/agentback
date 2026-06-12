// Runs the MCP server over stdio — wire it into Claude/Cursor as a command.
import {Application} from './application.js';

const app = new Application({stdio: true});
await app.start();
console.error('{{name}} MCP server running on stdio');
