import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';

// One Zod schema set drives: TS types, runtime validation, OpenAPI 3.1,
// MCP tool schemas, and the rendered docs at /explorer + /mcp-inspector.
export const Greeting = z.object({greeting: z.string()});
export const HelloPath = z.object({name: z.string().min(1).max(64)});
export const EchoIn = z.object({text: z.string().min(1).max(280)});
export const EchoOut = z.object({echoed: z.string()});

@api({basePath: '/greet'})
@mcpServer()
export class GreetingController {
  // REST: GET /greet/hello/{name}
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  // REST: POST /greet/echo — and the SAME method shape as an MCP tool below.
  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text};
  }

  // MCP tool sharing the schemas (visible at /mcp and in the inspector).
  @tool('echo', {description: 'Echo back the text.', input: EchoIn})
  async echoTool(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }
}
