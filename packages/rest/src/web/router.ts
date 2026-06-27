// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export interface RouteRecord<T> {
  method: string;
  /** Path template with `{name}` placeholders, e.g. `/greet/hello/{name}`. */
  template: string;
  value: T;
}

export interface RouteMatch<T> {
  value: T;
  params: Record<string, string>;
}

interface CompiledRoute<T> {
  method: string;
  segments: string[];
  /**
   * Precompiled matcher for the whole path. Param segments capture
   * `([^/]+)`; literal segments are regex-escaped so `.` and friends match
   * literally. Trailing slash is optional (`/?$`), matching the old
   * normalization, and the segment count is fixed by the pattern.
   */
  regexp: RegExp;
  /** Param names in capture-group order, e.g. `/a/{x}/b/{y}` → ['x','y']. */
  paramNames: string[];
  value: T;
}

const isParam = (seg: string): boolean =>
  seg.startsWith('{') && seg.endsWith('}');

function splitPath(p: string): string[] {
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/');
}

/** Structural key: params normalized to `{}` so name differences collide. */
function structuralKey(method: string, segments: string[]): string {
  return method + ' ' + segments.map(s => (isParam(s) ? '{}' : s)).join('/');
}

/** Escape regex-special chars so a literal segment matches literally. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a route's segments to a single anchored `RegExp` plus the ordered
 * param-name list. `/greet/{name}` → `^/greet/([^/]+)/?$` capturing `name`;
 * the empty-segment (root) case → `^/?$`. Per-route compiled regexes are safe
 * (each is independent); a single merged mega-regex over all routes (Hono's
 * `RegExpRouter`) is a possible further optimization but higher risk, so it is
 * deliberately not attempted here.
 */
function compile(segments: string[]): {regexp: RegExp; paramNames: string[]} {
  const paramNames: string[] = [];
  const body = segments
    .map(seg => {
      if (isParam(seg)) {
        paramNames.push(seg.slice(1, -1));
        return '/([^/]+)';
      }
      return '/' + escapeRegExp(seg);
    })
    .join('');
  // `body` is '' for the root route → `^/?$`; otherwise `^/a/b/?$`.
  return {regexp: new RegExp('^' + body + '/?$'), paramNames};
}

export class Router<T> {
  private readonly routes: CompiledRoute<T>[] = [];
  private readonly seen = new Set<string>();

  add(record: RouteRecord<T>): void {
    const method = record.method.toUpperCase();
    const segments = splitPath(record.template);
    const key = structuralKey(method, segments);
    if (this.seen.has(key)) {
      throw new Error(
        `Router: duplicate route ${record.method} ${record.template} ` +
          `(a structurally identical route is already registered)`,
      );
    }
    this.seen.add(key);
    const {regexp, paramNames} = compile(segments);
    this.routes.push({method, segments, regexp, paramNames, value: record.value});
    // Specificity order: at the first segment where two routes differ in kind,
    // a literal is more specific than a param. Stable sort keeps registration
    // order for equally-specific routes. So /users/me beats /users/{id}
    // regardless of who was added first.
    this.routes.sort((a, b) => {
      const n = Math.min(a.segments.length, b.segments.length);
      for (let i = 0; i < n; i++) {
        const ap = isParam(a.segments[i]!);
        const bp = isParam(b.segments[i]!);
        if (ap !== bp) return ap ? 1 : -1; // literal (false) sorts first
      }
      return 0;
    });
  }

  match(method: string, pathname: string): RouteMatch<T> | undefined {
    const verb = method.toUpperCase();
    // Normalize the incoming path the same way templates were normalized at
    // add() time: collapse leading slashes and strip a trailing one. The
    // compiled regex's `/?$` also tolerates a trailing slash; doing both keeps
    // trailing-slash + multi-slash semantics identical to the old splitPath.
    const path = '/' + splitPath(pathname).join('/');
    for (const route of this.routes) {
      if (route.method !== verb) continue;
      const m = route.regexp.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.paramNames.length; i++) {
        try {
          // Captures are decoded per-param; malformed %-encoding → non-match
          // (never throws), exactly as before.
          params[route.paramNames[i]!] = decodeURIComponent(m[i + 1]!);
        } catch {
          ok = false;
          break;
        }
      }
      if (ok) return {value: route.value, params};
    }
    return undefined;
  }
}
