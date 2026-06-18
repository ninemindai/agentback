// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import pMapFn, {Mapper, Options} from 'p-map';
import {loggers} from './debug-factory.js';

const {trace} = loggers('loopback:pmap');

/**
 * Create an iterable by the range
 * @param start - Stating index (inclusive)
 * @param end - Ending index (exclusive)
 * @param step - Step
 * @returns
 */
export function iterateByRange(start = 0, end = Infinity, step = 1) {
  let nextIndex = start;
  let iterationCount = 0;
  const iterable: Iterable<number> = {
    *[Symbol.iterator]() {
      for (;;) {
        if (nextIndex < end) {
          const value = nextIndex;
          nextIndex += step;
          iterationCount++;
          yield value;
        } else {
          return iterationCount;
        }
      }
    },
  };
  return iterable;
}

/**
 * Create an iterable by the limit and offset
 * @param limit - Limit
 * @param offset - Offset
 * @returns
 */
export function iterateByLimit(limit: number, offset = 0) {
  return iterateByRange(offset, offset + limit);
}

function paginateList<T>(list: Iterable<T>, pageSize = 100) {
  const iterator = list[Symbol.iterator]();
  const iterable: Iterable<T[]> = {
    *[Symbol.iterator]() {
      for (;;) {
        const page: T[] = [];
        let i = 0;
        while (i < pageSize) {
          const result = iterator.next();
          if (result.done) {
            if (page.length) {
              yield page;
            }
            return result.value;
          }
          page.push(result.value);
          i++;
        }
        if (page.length) {
          yield page;
        }
      }
    },
  };
  return iterable;
}

function paginateRanges(range: number | [number, number], pageSize = 100) {
  if (typeof range === 'number') {
    range = [0, range - 1];
  }
  const iterator = iterateByRange(range[0], range[1] + 1)[Symbol.iterator]();
  const iterable: Iterable<{start: number; end: number}> = {
    *[Symbol.iterator]() {
      for (;;) {
        let start = undefined;
        let end = undefined;
        let i = 0;
        while (i < pageSize) {
          const result = iterator.next();
          if (result.done) {
            if (start != null && end != null) {
              yield {start, end};
            }
            return result.value;
          }
          if (start == null) {
            start = result.value;
          }
          end = result.value;
          i++;
        }
        if (start != null && end != null) {
          yield {start, end};
        }
      }
    },
  };
  return iterable;
}

function paginatePages(size: number, pageSize = 100) {
  const iterator = iterateByLimit(size)[Symbol.iterator]();
  const iterable: Iterable<{offset: number; limit: number}> = {
    *[Symbol.iterator]() {
      for (;;) {
        let offset = undefined;
        let limit = 0;
        let i = 0;
        while (i < pageSize) {
          const result = iterator.next();
          if (result.done) {
            if (offset != null) {
              yield {offset, limit};
            }
            return result.value;
          }
          if (offset == null) {
            offset = result.value;
          }
          limit++;
          i++;
        }
        if (offset != null) {
          yield {offset, limit};
        }
      }
    },
  };
  return iterable;
}

/**
 * Options for paginated p-map
 */
export type PMapByPageOptions = Options & {
  pageSize?: number;
};

/**
 * Map a large list asynchronously with pagination
 * @param input - A large list of items
 * @param mapper - Mapping function
 * @param options - Options for mapping, including `concurrency` and `pageSize`
 * @returns
 */
export async function pMapByPage<T = unknown, N = unknown>(
  input: Iterable<T>,
  mapper: Mapper<T[], N>,
  options?: PMapByPageOptions,
): Promise<N[]> {
  const itemsByPage = paginateList(input, options?.pageSize);
  const pages = await pMap(itemsByPage, mapper, options);
  return pages;
}

/**
 * Map a large collection asynchronously with pagination (start, end)
 * @param range - Size of the collection
 * @param mapper - Mapping function that handles a range (start, end)
 * @param options - Options for mapping, including `concurrency` and `pageSize`
 * @returns
 */
export async function pMapByRange<N = unknown>(
  range: number | [number, number],
  mapper: Mapper<{start: number; end: number}, N>,
  options?: PMapByPageOptions,
): Promise<N[]> {
  const rangesByPage = paginateRanges(range, options?.pageSize);
  const pages = await pMap(rangesByPage, mapper, options);
  return pages;
}

/**
 * Map a large collection asynchronously with pagination (offset, limit)
 * @param size - Size of the collection
 * @param mapper - Mapping function that handles a page (offset, limit)
 * @param options - Options for mapping, including `concurrency` and `pageSize`
 * @returns
 */
export async function pMapByPageOffsetAndLimit<N = unknown>(
  size: number,
  mapper: Mapper<{offset: number; limit: number}, N>,
  options?: PMapByPageOptions,
): Promise<N[]> {
  const itemsByPage = paginatePages(size, options?.pageSize);
  const pages = await pMap(itemsByPage, mapper, options);
  return pages;
}

export function mapByKeyValue<T, V = T>(
  items: T[],
  getKey: (item: T) => string | {key: string; value: V},
) {
  const map: Record<string, V[]> = {};
  items.forEach(i => {
    let kv = getKey(i);
    if (typeof kv === 'string') {
      kv = {
        key: kv,
        value: i as unknown as V,
      };
    }
    map[kv.key] = map[kv.key] ?? [];
    map[kv.key].push(kv.value);
  });
  return map;
}

export function pMap<Element, NewElement>(
  input: Iterable<Element>,
  mapper: Mapper<Element, NewElement>,
  options?: Options,
): Promise<NewElement[]> {
  return pMapFn(input, mapper, {concurrency: 5, ...options});
}

export {Mapper, Options} from 'p-map';

export interface AsyncFetchOptions<VALUE, STATE, SUMMARY = undefined> {
  next: (
    state?: STATE,
  ) => Promise<{state?: STATE; value?: VALUE; done?: boolean}>;
  initialState?: STATE;
  reduce?: (prev: SUMMARY | undefined, current: VALUE) => SUMMARY;
  initialSummary?: SUMMARY;
}

/**
 * Async iterator to fetch items from a collection asynchronously
 * @param options - Options to fetch next item
 * @returns
 */
export async function* fetchIterator<VALUE, STATE, SUMMARY = undefined>(
  options: AsyncFetchOptions<VALUE, STATE, SUMMARY>,
) {
  let state = options.initialState;
  let summary = options.initialSummary;
  let i = 0;
  for (;;) {
    trace('[%s] state=%O, summary=%O', i++, state, summary);
    const result = await options.next(state);
    state = result.state;
    if (result.value != null) {
      if (options.reduce != null) {
        summary = options.reduce(summary, result.value);
      }
      yield result.value;
    }
    if (result.value == null || result.done) return summary;
  }
}

export interface AsyncFetchByPageOptions<VALUE, STATE> {
  next: (
    state?: STATE,
  ) => Promise<{state?: STATE; value?: VALUE[]; done?: boolean}>;
  initialState?: STATE;
}

/**
 * Fetch items by page asynchronously and return items one by one
 * @param options - Options to fetch next page
 * @returns
 */
export async function* fetchIteratorByPage<VALUE, STATE>(
  options: AsyncFetchByPageOptions<VALUE, STATE>,
) {
  let state = options.initialState;
  let i = 0;
  for (;;) {
    trace('[%s] state=%O', i++, state);
    const result = await options.next(state);
    state = result.state;
    if (result.value != null) {
      for (const v of result.value) {
        yield v;
      }
    }
    if (result.done) return;
  }
}

/**
 * Fetch items by page asynchronously and return items by page
 * @param options - Options to fetch next page
 * @returns
 */
export async function* fetchIteratorByBatch<VALUE, STATE>(
  options: AsyncFetchByPageOptions<VALUE, STATE>,
) {
  let state = options.initialState;
  let i = 0;
  for (;;) {
    trace('[%s] state=%O', i++, state);
    const result = await options.next(state);
    state = result.state;
    if (result.value != null) {
      yield result.value;
    }
    if (result.done) return;
  }
}

/**
 * Process items from an async iterator by page
 * @param input - Async iterator
 * @param mapper - Mapping function
 * @param options - Options
 * @returns
 */
export async function pMapByAsyncIterator<T = unknown, N = unknown>(
  input: AsyncIterable<T>,
  mapper: Mapper<T[], N>,
  options?: PMapByPageOptions,
): Promise<N[]> {
  const pageSize = options?.pageSize ?? 100;
  const result: N[] = [];
  let page = 0;
  let items = [];
  let tasks = [];
  let total = 0;
  const concurrency = options?.concurrency ?? 5;
  for await (const item of input) {
    if (items.length < pageSize) {
      items.push(item);
      if (items.length === pageSize) {
        trace('Total number of items fetched: %s', ++total);
        trace('Processing page %s with %s items', page, items.length);
        // Process the page
        tasks.push(mapper(items, page++));
        if (tasks.length === concurrency) {
          trace('Processing %s tasks', tasks.length);
          const data = await pMap(tasks, t => t, {
            concurrency,
            stopOnError: options?.stopOnError,
          });
          result.push(...data);
          tasks = [];
        }
        items = [];
      }
    }
  }
  if (items.length) {
    // Process the last page
    tasks.push(mapper(items, page));
  }
  const data = await pMap(tasks, t => t, {
    concurrency: options?.concurrency,
    stopOnError: options?.stopOnError,
  });
  result.push(...data);
  return result;
}
