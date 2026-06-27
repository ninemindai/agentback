// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: hello-hosts
// This file is licensed under the MIT License.

import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';

export const GreetPath = z.object({name: z.string().min(1).max(64)});
export const Greeting = z.object({greeting: z.string()});
export const EchoIn = z.object({message: z.string().min(1).max(280)});
export const EchoOut = z.object({echoed: z.string()});

/** Shared controller — registered once, served by whichever host runs it. */
@api({})
export class GreetController {
  @get('/greet/{name}', {path: GreetPath, response: Greeting})
  greet({path}: {path: z.infer<typeof GreetPath>}): z.infer<typeof Greeting> {
    return {greeting: `Hello, ${path.name}!`};
  }

  @post('/echo', {body: EchoIn, response: EchoOut})
  echo({body}: {body: z.infer<typeof EchoIn>}): z.infer<typeof EchoOut> {
    return {echoed: body.message};
  }
}
