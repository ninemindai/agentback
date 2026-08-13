// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * installGate() — the shared liveness gate behind every revertible install's
 * Express footprint (docs/proposals/revertible-installs.md). Two forms, one
 * flag: `gate` fronts a METHOD chain (dead → next('route') falls through to
 * the app's 404), `wrap` turns a middleware into a pass-through when dead.
 */

import {describe, expect, it} from 'vitest';
import express from 'express';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {installGate} from '../../install-gate.js';

async function serve(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

describe('installGate', () => {
  it('gate lets a route serve while live and 404s it after off()', async () => {
    const app = express();
    const g = installGate();
    app.get('/thing', g.gate, (_req, res) => void res.json({ok: true}));
    const {url, close} = await serve(app);
    try {
      expect((await fetch(`${url}/thing`)).status).toBe(200);

      g.off();

      expect((await fetch(`${url}/thing`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("gate's next('route') skips the rest of the chain — later middleware never runs when dead", async () => {
    const app = express();
    const g = installGate();
    let sideEffects = 0;
    app.post(
      '/upload',
      g.gate,
      (_req, _res, next) => {
        sideEffects++;
        next();
      },
      (_req, res) => void res.json({ok: true}),
    );
    const {url, close} = await serve(app);
    try {
      await fetch(`${url}/upload`, {method: 'POST'});
      expect(sideEffects).toBe(1);

      g.off();

      const res = await fetch(`${url}/upload`, {method: 'POST'});
      expect(res.status).toBe(404);
      expect(sideEffects).toBe(1);
    } finally {
      await close();
    }
  });

  it('wrap runs the middleware while live and passes through after off()', async () => {
    const app = express();
    const g = installGate();
    const guard: express.RequestHandler = (_req, res) =>
      void res.status(401).json({error: 'denied'});
    app.use('/secure', g.wrap(guard));
    app.get('/secure/data', (_req, res) => void res.json({open: true}));
    const {url, close} = await serve(app);
    try {
      expect((await fetch(`${url}/secure/data`)).status).toBe(401);

      g.off();

      expect((await fetch(`${url}/secure/data`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('off() is idempotent', () => {
    const g = installGate();
    g.off();
    expect(() => g.off()).not.toThrow();
  });
});
