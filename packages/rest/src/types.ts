// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {CorsOptions} from 'cors';

export interface RestServerConfig {
  port?: number;
  host?: string;
  basePath?: string;
  openApiSpec?: {
    /** URL path where the OpenAPI document is served. Default '/openapi.json'. */
    path?: string;
    /** Static spec values to merge into the auto-assembled doc. */
    overrides?: Record<string, unknown>;
  };
  /**
   * Enable CORS for every route.
   *
   * - Omit (or set to `false`) — no CORS middleware is mounted.
   * - `true` — mount the `cors` package with its defaults (`origin: '*'`).
   * - Object — passed through to `cors(...)`; full options at
   *   https://github.com/expressjs/cors#configuration-options.
   *
   * For per-route or path-prefixed CORS, register middleware manually via
   * `app.middleware(...)`.
   */
  cors?: boolean | CorsOptions;
  /**
   * AX (agent experience) artifacts. By default the server serves
   * `/llms.txt` (compact endpoint index) and `/llms-full.txt` (full
   * per-endpoint schemas), generated from the same route registry as
   * /openapi.json. Set to `false` to disable, or override the paths.
   * Components can append sections by binding {@link AxSection} values
   * tagged `AX_SECTION_TAG`.
   */
  ax?:
    | false
    | {
        /** URL path for the compact index. Default '/llms.txt'. */
        llmsTxtPath?: string;
        /** URL path for the expanded document. Default '/llms-full.txt'. */
        llmsFullTxtPath?: string;
      };
  /** Server-sent events (stream routes declared with `streamOf:`). */
  sse?: {
    /**
     * Heartbeat interval in ms — writes `: ping` comment frames to defeat
     * idle-connection proxies. Off when omitted.
     */
    pingMs?: number;
  };
}

export const DEFAULT_REST_CONFIG: Required<
  Omit<RestServerConfig, 'openApiSpec' | 'cors' | 'sse' | 'ax'>
> & {
  openApiSpec: NonNullable<RestServerConfig['openApiSpec']>;
  cors: RestServerConfig['cors'];
  sse?: RestServerConfig['sse'];
  ax?: RestServerConfig['ax'];
} = {
  port: 3000,
  host: '127.0.0.1',
  basePath: '',
  openApiSpec: {
    path: '/openapi.json',
  },
  cors: undefined,
};
