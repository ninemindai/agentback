// Copyright Ninemind.ai 2026. All Rights Reserved.
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
    this.routes.push({method, segments, value: record.value});
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
    const segs = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== verb) continue;
      if (route.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const tmpl = route.segments[i]!;
        const actual = segs[i]!;
        if (isParam(tmpl)) {
          try {
            params[tmpl.slice(1, -1)] = decodeURIComponent(actual);
          } catch {
            ok = false; // malformed %-encoding → non-match
            break;
          }
        } else if (tmpl !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return {value: route.value, params};
    }
    return undefined;
  }
}
