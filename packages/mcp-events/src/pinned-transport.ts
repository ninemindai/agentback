// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ipVersion, isPublicAddress} from '@agentback/common';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  TransportError,
  type WebhookTransport,
} from './transport.js';

/** One resolved address, as `dns.lookup(…, {all: true})` returns it. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it currently maps to. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PinnedTransportOptions {
  /**
   * Permit loopback/private/reserved destinations. **Development and tests
   * only** — it disables the SSRF guard. Off by default.
   */
  allowPrivateAddresses?: boolean;
  /**
   * Permit `http:` callback URLs. **Tests only**: subscribe already refuses
   * anything but `https`, so this is for driving the transport directly.
   */
  allowHttp?: boolean;
  /** Name resolution. Defaults to `dns.lookup` with `{all: true}`. */
  resolve?: Resolver;
  /**
   * Extra trusted CAs (PEM) — for a test or a private PKI. Added to Node's
   * public roots, not substituted for them.
   */
  ca?: string | string[];
  /** Cap on how much of a response body is read (default 64 KiB). */
  maxResponseBytes?: number;
}

/**
 * The Node webhook transport with the resolved IP **pinned** — the one new
 * security primitive webhook delivery needs, since the callback URL is
 * attacker-supplied by design.
 *
 * A check at subscribe time is not enough: a rebinding name answers with a
 * public address when checked and an internal one when connected to. So the
 * check happens at connect time, inside the socket's own `lookup`: the name
 * is resolved, **every** address is classified (`isPublicAddress`, the IANA
 * special-purpose registries — shared with `mcp-connect`), and the socket
 * connects to the address that was just validated; there is no second
 * resolution for an attacker to race. SNI and certificate verification keep
 * the original hostname, and `Host` carries it. Redirects are never followed:
 * `node:https` does not follow them, and a 3xx is returned as a failed
 * response. Used for verification and delivery alike.
 */
export function createPinnedTransport(
  opts: PinnedTransportOptions = {},
): WebhookTransport {
  const max = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return async req => {
    // Loaded lazily so importing this package never pulls `node:*` onto a
    // host that only uses `fetchTransport`.
    const [{request: httpsRequest}, {request: httpRequest}, dns, tls] =
      await Promise.all([
        import('node:https'),
        import('node:http'),
        import('node:dns'),
        import('node:tls'),
      ]);
    const url = new URL(req.url);
    const secure = url.protocol === 'https:';
    if (!secure && !(opts.allowHttp && url.protocol === 'http:')) {
      throw new TransportError(
        'connection_refused',
        `refusing a non-https callback URL (${url.protocol})`,
      );
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    // An IP literal never reaches `lookup` — Node connects to it directly —
    // so classify it here.
    if (ipVersion(hostname) && !permitted(hostname, opts)) {
      throw blocked(hostname);
    }
    const resolve: Resolver =
      opts.resolve ??
      (name =>
        dns.promises.lookup(name, {all: true, verbatim: true}) as Promise<
          ResolvedAddress[]
        >);

    const lookup = (
      name: string,
      options: {all?: boolean},
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | ResolvedAddress[],
        family?: number,
      ) => void,
    ): void => {
      resolve(name).then(
        addrs => {
          // Refuse if ANY answer is non-public: the socket may pick any of
          // them (happy eyeballs), and a mixed answer is itself a red flag.
          const bad = addrs.find(a => !permitted(a.address, opts));
          if (bad || addrs.length === 0) {
            callback(
              Object.assign(
                new Error(
                  bad
                    ? `${name} resolves to a non-public address`
                    : `${name} did not resolve`,
                ),
                {code: 'EBLOCKED'},
              ),
              '',
            );
            return;
          }
          if (options.all) callback(null, addrs);
          else callback(null, addrs[0]!.address, addrs[0]!.family);
        },
        err => callback(err as NodeJS.ErrnoException, ''),
      );
    };

    const doRequest = secure ? httpsRequest : httpRequest;
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const fail = (err: TransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        reject(err);
      };
      const r = doRequest(
        {
          protocol: url.protocol,
          hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            ...req.headers,
            'content-length': String(Buffer.byteLength(req.body)),
          },
          lookup: lookup as never,
          // A fresh connection per request: an agent's pooled socket could
          // outlive the address check it was opened under.
          agent: false,
          // Node REPLACES the public roots when `ca` is set; keep them, so a
          // private CA is added, not substituted.
          ...(secure && opts.ca
            ? {ca: [...tls.rootCertificates, ...[opts.ca].flat()]}
            : {}),
        },
        res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            if (size < max) chunks.push(c);
            size += c.length;
            // Past the cap, stop reading: the status is all that matters.
            if (size >= max) res.destroy();
          });
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            req.signal?.removeEventListener('abort', onAbort);
            resolvePromise({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).subarray(0, max).toString('utf8'),
            });
          };
          res.on('end', done);
          res.on('close', done);
          res.on('error', done);
        },
      );
      const timer = setTimeout(() => {
        r.destroy();
        fail(new TransportError('timeout', 'webhook request timed out'));
      }, req.timeoutMs);
      const onAbort = () => {
        r.destroy();
        fail(new TransportError('timeout', 'webhook request aborted'));
      };
      if (req.signal?.aborted) onAbort();
      req.signal?.addEventListener('abort', onAbort, {once: true});
      r.on('error', err => fail(classify(err as NodeJS.ErrnoException)));
      r.end(req.body);
    });
  };
}

function permitted(address: string, opts: PinnedTransportOptions): boolean {
  return opts.allowPrivateAddresses === true || isPublicAddress(address);
}

function blocked(address: string): TransportError {
  return new TransportError(
    'connection_refused',
    `refusing to connect to non-public address ${address}`,
  );
}

const TLS_CODE =
  /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|EPROTO$|HOSTNAME_MISMATCH$)/;

/** Map a socket error onto the protocol's failure categories. */
function classify(err: NodeJS.ErrnoException): TransportError {
  const code = err.code ?? '';
  if (code === 'ETIMEDOUT') {
    return new TransportError('timeout', 'webhook request timed out', {
      cause: err,
    });
  }
  if (TLS_CODE.test(code)) {
    return new TransportError('tls_error', 'TLS handshake failed', {
      cause: err,
    });
  }
  return new TransportError(
    'connection_refused',
    code === 'EBLOCKED' ? err.message : 'webhook request failed to connect',
    {cause: err},
  );
}
