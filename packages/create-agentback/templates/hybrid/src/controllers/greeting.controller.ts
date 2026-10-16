import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';

// One Zod schema set drives: TS types, runtime validation, OpenAPI 3.1,
// MCP tool schemas, and the rendered docs at /explorer + /mcp-inspector.
export const Greeting = z.object({greeting: z.string()});
export const HelloPath = z.object({name: z.string().min(1).max(64)});
export const EchoIn = z.object({text: z.string().min(1).max(280)});
export const EchoOut = z.object({echoed: z.string()});

// One place for the echo behaviour. The REST route and the MCP tool below both
// call it, so a change here changes both callers.
export function echo(text: string): z.infer<typeof EchoOut> {
  return {echoed: text};
}

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

  // REST: POST /greet/echo. Calls the same `echo` as the MCP tool below.
  @post('/echo', {body: EchoIn, response: EchoOut})
  async echoRoute(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return echo(input.body.text);
  }

  // MCP tool `echo` with the same schemas (visible at /mcp and in the
  // inspector). It calls the same `echo` as the REST route above.
  @tool('echo', {
    description: 'Echo back the text.',
    input: EchoIn,
    output: EchoOut,
  })
  async echoTool(
    input: z.infer<typeof EchoIn>,
  ): Promise<z.infer<typeof EchoOut>> {
    return echo(input.text);
  }
}
