// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * This CLI's own version, read from its package.json.
 *
 * Its own module rather than living beside the `update` code, because
 * `--version` ships in the router and `update` resolves its default target
 * from the same value — neither should have to depend on the other.
 */
export function selfVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/version.js -> ../package.json
  const pkgPath = path.resolve(here, '..', 'package.json');
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as {version: string})
    .version;
}
