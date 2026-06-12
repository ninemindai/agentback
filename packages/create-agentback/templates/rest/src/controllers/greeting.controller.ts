import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';

// One Zod schema set drives: TS types, runtime validation, OpenAPI 3.1,
// and the rendered docs at /explorer.
export const Greeting = z.object({greeting: z.string()});
export const HelloPath = z.object({name: z.string().min(1).max(64)});
export const EchoIn = z.object({text: z.string().min(1).max(280)});
export const EchoOut = z.object({echoed: z.string()});

@api({basePath: '/greet'})
export class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text};
  }
}
