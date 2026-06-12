import {z} from 'zod';
import {mcpServer, tool} from '@agentback/mcp';

export const EchoIn = z.object({text: z.string().min(1).max(280)});
export const AddIn = z.object({a: z.number().int(), b: z.number().int()});

@mcpServer()
export class EchoTools {
  @tool('echo', {description: 'Echo back the text.', input: EchoIn})
  async echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('add', {description: 'Add two integers.', input: AddIn})
  async add(input: z.infer<typeof AddIn>) {
    return {sum: input.a + input.b};
  }
}
