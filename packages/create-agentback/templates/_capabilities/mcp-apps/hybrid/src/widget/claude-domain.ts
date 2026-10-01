import {createHash} from 'node:crypto';

/**
 * Claude renders a widget on a dedicated sandbox origin derived from the
 * server URL users add as a connector: the first 32 hex characters of its
 * SHA-256, followed by `.claudemcpcontent.com`.
 */
export function claudeDomain(serverUrl: string): string {
  return (
    createHash('sha256').update(serverUrl).digest('hex').slice(0, 32) +
    '.claudemcpcontent.com'
  );
}

/**
 * The widget `domain` for the public MCP URL (`PUBLIC_URL` + `/mcp`), or
 * `undefined` when `PUBLIC_URL` is unset — local development, and hosts other
 * than Claude, need none. It is computed once, so it assumes one public URL
 * per process, and it is sent to every host.
 */
export function widgetDomain(
  publicUrl = process.env.PUBLIC_URL,
): string | undefined {
  if (!publicUrl) return undefined;
  return claudeDomain(new URL('/mcp', publicUrl).href);
}
