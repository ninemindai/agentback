// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// `sortListOfGroups` was relocated to `@agentback/common` so both the Express
// middleware chain and the runtime-neutral Web middleware onion order by the
// same topological sort. Re-exported here for backward compatibility — existing
// `@agentback/express` consumers (and its `index.ts`) import it from this path.
export {sortListOfGroups} from '@agentback/common';
