// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/rest-explorer
// This file is licensed under the MIT License.

// Console page contribution. The REST/OpenAPI explorer is Swagger UI (a
// third-party app served at its own path), so inside the unified console it is
// embedded as an iframe rather than re-implemented. Imported (build-time) by
// @agentback/console's SPA bundle via the package's `./console` export.

export const pages = [
  {
    id: 'api',
    title: 'API',
    icon: '⎘',
    order: 20,
    route: '/api',
    component: ({extra}: {apiBase: string; extra?: {url?: string}}) => (
      <iframe
        src={extra?.url ?? '/explorer/'}
        title="API Explorer"
        style={{
          width: '100%',
          height: 'calc(100vh - 56px)',
          border: 0,
          display: 'block',
        }}
      />
    ),
  },
];
