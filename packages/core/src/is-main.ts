// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {pathToFileURL} from 'node:url';

/**
 * Tells whether the calling module is the program's entry point — the file
 * Node was launched with, as opposed to one that was `import`ed elsewhere.
 *
 * Guard a top-level `await main()` with it to keep the module import-safe, so
 * tests (or other modules) can import its exports without booting a server:
 *
 * ```ts
 * if (isMain(import.meta)) {
 *   await main();
 * }
 * ```
 *
 * Prefers the native `import.meta.main` flag (Node 24.2+) and falls back to
 * comparing `import.meta.url` against `process.argv[1]` on older runtimes, so
 * the same guard works down to the project's Node 22.13 floor.
 *
 * @param meta - The calling module's `import.meta`.
 */
export function isMain(meta: ImportMeta): boolean {
  if (typeof meta.main === 'boolean') return meta.main;
  const entry = process.argv[1];
  return entry != null && meta.url === pathToFileURL(entry).href;
}
