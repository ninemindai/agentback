// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Schemas live in their own module so any client (TS, in-process tests,
// other workspace packages) can import them without dragging in the
// server's controllers, decorators, or runtime. The same `z.ZodType` is
// the contract for both ends — no codegen, no drift.

import {z} from 'zod';

export const Greeting = z.object({greeting: z.string()});
export const HelloPath = z.object({name: z.string().min(1).max(64)});

export const EchoIn = z.object({text: z.string().min(1).max(280)});
export const EchoOut = z.object({echoed: z.string(), at: z.string()});

export const LoginIn = z.object({
  username: z.string().min(1),
  roles: z.array(z.string()).optional(),
});
export const LoginOut = z.object({token: z.string()});

export const Me = z.object({
  id: z.string(),
  name: z.string(),
  roles: z.array(z.string()),
});

export const Secret = z.object({secret: z.string()});

// Machine-auth demo (anonymous / api-key / client-credentials) outputs.
export const PrincipalOut = z.object({ok: z.boolean(), principal: z.string()});
export const OrdersReport = z.object({
  ok: z.boolean(),
  client: z.string(),
  scope: z.string(),
});
