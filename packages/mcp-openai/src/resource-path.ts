// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {MCPBindings} from '@agentback/mcp';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import {OPENAI_RESOURCE_META_KEY} from './shared.js';

export interface ResourcePathOptions {
  /**
   * Directories the path must resolve inside (after symlinks). Required: a
   * path from the host is never trusted as-is.
   */
  roots: string[];
  /**
   * Accept the path on an HTTP request too. Off by default: over HTTP the
   * host's filesystem is usually not this server's, so the path names a file
   * on someone else's machine. Turn it on only for a server that runs on the
   * user's own machine behind a local HTTP mount.
   */
  allowHttp?: boolean;
}

interface Source {
  meta?: Readonly<Record<string, unknown>>;
  request?: unknown;
}

function forbidden(message: string): AgentError {
  return new AgentError(message, {
    code: ErrorCodes.FORBIDDEN,
    status: 403,
    retryable: false,
  });
}

/**
 * The absolute filesystem path ChatGPT attaches to a tool call made from a
 * file entrypoint (`_meta["openai/resource"].path`), resolved and confined:
 * `undefined` when the call carries none.
 *
 * The path is resolved with `realpath` (so a symlink cannot escape) and must
 * lie inside one of `roots` — a root itself or below it, never a sibling that
 * merely shares a prefix. It is refused (403) outside the roots, on an HTTP
 * request unless `allowHttp`, or when malformed (400). A missing file is 404.
 *
 * Pass the request context (`@inject.context()` in a tool method): only a
 * real MCP request (one with transport extras) yields a path, so an
 * in-process `callTool`, simulated or not, returns `undefined`. Or pass the
 * request's `meta` (`MCPBindings.REQUEST_META`) and `request`
 * (`MCPBindings.REQUEST_INFO`) yourself — then **you** vouch for both.
 *
 * Node-only: it imports `node:fs` and `node:path` when called.
 *
 * @experimental Tracks OpenAI's MCP extensions spec (0.1.x).
 */
export async function resourcePath(
  source: Context | Source,
  options: ResourcePathOptions,
): Promise<string | undefined> {
  const {meta, request} = readSource(source);
  const entry = meta?.[OPENAI_RESOURCE_META_KEY];
  if (entry === undefined) return undefined;
  const raw = (entry as {path?: unknown} | null)?.path;
  if (typeof entry !== 'object' || entry === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !raw) {
    throw new AgentError(
      `_meta["${OPENAI_RESOURCE_META_KEY}"].path must be a string`,
      {
        code: ErrorCodes.INVALID_INPUT,
      },
    );
  }
  if (request !== undefined && !options.allowHttp) {
    throw forbidden(
      'File paths from the host are not accepted over HTTP; the path names ' +
        "a file on the host's machine. Enable resourcePath({allowHttp}) only " +
        "for a server running on the user's own machine.",
    );
  }
  if (!options.roots?.length) {
    throw new Error('resourcePath: roots must name at least one directory');
  }
  const path = await import('node:path');
  const {realpath} = await import('node:fs/promises');
  if (!path.isAbsolute(raw)) {
    throw new AgentError('The file path must be absolute.', {
      code: ErrorCodes.INVALID_INPUT,
    });
  }
  const bases: string[] = [];
  for (const root of options.roots) {
    try {
      bases.push(await realpath(root));
    } catch {
      // A missing root confines nothing.
    }
  }
  const inside = (p: string) =>
    bases.some(base => {
      const rel = path.relative(base, p);
      return !(
        rel === '..' ||
        rel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rel)
      );
    });
  // Lexical containment first, so a path outside the roots is refused the
  // same way whether or not it exists — the answer never reveals that.
  // (A root reached through a symlink is compared by its resolved path, so
  // a lexical miss is re-checked after resolution below.)
  const lexical = path.resolve(raw);
  const lexicallyInside =
    inside(lexical) ||
    options.roots.some(root => {
      const rel = path.relative(path.resolve(root), lexical);
      return !(
        rel === '..' ||
        rel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rel)
      );
    });
  if (!lexicallyInside) throw outsideRoots();
  let resolved: string;
  try {
    resolved = await realpath(raw);
  } catch {
    throw new AgentError('The file does not exist.', {
      code: ErrorCodes.NOT_FOUND,
      status: 404,
      retryable: false,
    });
  }
  // Re-checked after resolution: a symlink inside a root may point out.
  if (!inside(resolved)) throw outsideRoots();
  return resolved;
}

function outsideRoots(): AgentError {
  return forbidden('The file is outside the directories this server may read.');
}

function readSource(source: Context | Source): Source {
  if (isContext(source)) {
    // Only a real transport request carries a host-attached path. An
    // in-process call — including one simulating a host's `_meta` — has no
    // transport extras and so no path, which also keeps `allowHttp` from
    // being sidestepped by a call that is itself served over HTTP.
    const extra = source.getSync(MCPBindings.REQUEST_EXTRA, {optional: true});
    if (!extra) return {};
    return {
      meta: source.getSync(MCPBindings.REQUEST_META, {optional: true}),
      request:
        (extra as {http?: {req?: unknown}}).http?.req ??
        source.getSync(MCPBindings.REQUEST_INFO, {optional: true}),
    };
  }
  return source;
}

function isContext(v: unknown): v is Context {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Context).getSync === 'function' &&
    typeof (v as Context).bind === 'function'
  );
}
