// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import toposort from 'toposort';
import {loggers} from './utils/index.js';

const log = loggers('loopback:middleware');

/**
 * Sort the groups by their relative order
 * @param orderedGroups - A list of arrays - each of which represents a partial
 * order of groups.
 *
 * Pure (no Express dependency) — lives in `@agentback/common` so both the
 * Express middleware chain and the runtime-neutral Web middleware onion
 * (`@agentback/rest`) order by the same topological sort.
 */
export function sortListOfGroups(...orderedGroups: string[][]) {
  if (log.debug.enabled) {
    log.debug(
      'Dependency graph: %s',
      orderedGroups.map(edge => edge.join('->')).join(', '),
    );
  }
  const graph: [string, string][] = [];
  for (const groups of orderedGroups) {
    if (groups.length >= 2) {
      groups.reduce((prev: string | undefined, group) => {
        if (typeof prev === 'string') {
          graph.push([prev, group]);
        }
        return group;
      }, undefined);
    }
  }
  const sorted = toposort(graph);
  log.debug('Sorted groups: %s', sorted.join('->'));
  return sorted;
}
