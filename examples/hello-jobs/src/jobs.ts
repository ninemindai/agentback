// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// ONE Zod schema for two roles: the HTTP request body AND the job payload.
// `defineQueue` binds the queue name to the schema, so the same `EmailJob`
// validates the POST body, drives the OpenAPI doc, and is re-validated when
// the worker decodes the job off the queue. No drift between API and worker.

import {z} from 'zod';
import {defineQueue} from '@agentback/messaging';

export const EmailJob = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
});

/** The queue descriptor — name + the SAME schema, travelling together. */
export const SendEmail = defineQueue('send-email', EmailJob);
