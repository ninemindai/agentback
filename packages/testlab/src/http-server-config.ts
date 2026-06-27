// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import assert from 'assert';
import {readFileSync} from 'fs';
import {ServerOptions as HttpsServerOptions} from 'https';
import {ListenOptions} from 'net';
import path from 'path';

const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

// Read the dummy key/cert lazily: only callers that ask for an `https` config
// without their own TLS material need the fixtures. Reading at import time
// would make merely importing this module (e.g. via `@agentback/testing`)
// fail whenever the fixtures aren't on disk.
let dummyTlsConfig: {key: Buffer; cert: Buffer} | undefined;
function getDummyTlsConfig(): {key: Buffer; cert: Buffer} {
  return (dummyTlsConfig ??= {
    key: readFileSync(path.join(FIXTURES, 'key.pem')),
    cert: readFileSync(path.join(FIXTURES, 'cert.pem')),
  });
}

export interface HttpOptions extends ListenOptions {
  protocol?: 'http';
}

export interface HttpsOptions extends ListenOptions, HttpsServerOptions {
  protocol: 'https';
}

/**
 * An object that requires host and port properties
 */
export interface HostPort {
  host: string;
  port: number;
}

/**
 * Assertion type guard for TypeScript to ensure `host` and `port` are set
 * @param config - Host/port configuration
 */
function assertHostPort(config: Partial<HostPort>): asserts config is HostPort {
  assert(config.host != null, 'host is not set');
  assert(config.port != null, 'port is not set');
}

/**
 * Create an HTTP-server configuration that works well in test environments.
 *  - Ask the operating system to assign a free (ephemeral) port.
 *  - Use IPv4 localhost `127.0.0.1` to avoid known IPv6 issues in Docker-based
 *    environments like Travis-CI.
 *  - Provide default TLS key & cert when `protocol` is set to `https`.
 *
 * @param customConfig - Additional configuration options to apply.
 */
export function givenHttpServerConfig<T extends HttpOptions | HttpsOptions>(
  customConfig?: T,
): HostPort & T {
  const defaults: HostPort = {host: '127.0.0.1', port: 0};

  if (isHttpsConfig(customConfig)) {
    const config: T = {...customConfig};
    if (config.host == null) config.host = defaults.host;
    if (config.port == null) config.port = defaults.port;
    setupTlsConfig(config as HttpsOptions);
    assertHostPort(config);
    return config;
  }

  assertHttpConfig(customConfig);
  const config: T = {...customConfig};
  if (config.host == null) config.host = defaults.host;
  if (config.port == null) config.port = defaults.port;
  assertHostPort(config);
  return config;
}

function setupTlsConfig(config: HttpsServerOptions) {
  if ('key' in config && 'cert' in config) return;
  if ('pfx' in config) return;
  Object.assign(config, getDummyTlsConfig());
}

/**
 * Type guard to check if the parameter is `HttpsOptions`
 */
function isHttpsConfig(
  config?: HttpOptions | HttpsOptions,
): config is HttpsOptions {
  return config?.protocol === 'https';
}

/**
 * Type guard to assert the parameter is `HttpOptions`
 * @param config - Http config
 */
function assertHttpConfig(
  config?: HttpOptions | HttpsOptions,
): asserts config is HttpOptions {
  assert(config?.protocol == null || config?.protocol === 'http');
}
