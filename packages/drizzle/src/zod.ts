// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Re-exports of the `drizzle-zod` schema factories so app code has a single
 * import root and the version is centrally pinned against the workspace Zod
 * major.
 *
 * This lives on its own subpath — `@agentback/drizzle/zod` — rather than
 * the main index, because `drizzle-zod` is an *optional* peer dependency: a
 * static re-export from the main index would make the whole package fail to
 * load (`ERR_MODULE_NOT_FOUND`) for apps that only want `registerDrizzle` and
 * derive their Zod schemas some other way. Importing this subpath requires
 * `drizzle-zod` to be installed.
 *
 * ```ts
 * import {createInsertSchema, createSelectSchema} from '@agentback/drizzle/zod';
 * ```
 */
export {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-zod';
