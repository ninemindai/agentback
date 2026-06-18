// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, post} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import type {FetchHost} from '../../host/fetch.js';

// Parity arbiter for C3: confirmation + idempotency on the runtime-neutral Web
// dispatch path (RestHandler) must behave identically to the Express path. Both
// surfaces share ONE DI graph (an Application IS a Context) and therefore ONE
// confirmation/idempotency store instance — so the round-trip (issue → retry)
// is driven WITHIN a single surface (a token is single-use; a key replays once),
// and the two surfaces are compared by the SHAPE of their responses.

const DangerIn = z.object({target: z.string()});
const DangerOut = z.object({deleted: z.string()});
const ChargeIn = z.object({amount: z.number().positive()});
const ChargeOut = z.object({chargeId: z.string(), amount: z.number()});

// Side-effect counter proving the handler ran exactly once per idempotency key.
let chargeRuns = 0;

@api({basePath: '/safe'})
class SafeController {
  @post('/danger', {body: DangerIn, response: DangerOut, confirm: true})
  async danger(input: {
    body: z.infer<typeof DangerIn>;
  }): Promise<z.infer<typeof DangerOut>> {
    return {deleted: input.body.target};
  }

  @post('/charge', {body: ChargeIn, response: ChargeOut, idempotency: true})
  async charge(input: {
    body: z.infer<typeof ChargeIn>;
  }): Promise<z.infer<typeof ChargeOut>> {
    chargeRuns += 1;
    return {chargeId: `ch_${chargeRuns}`, amount: input.body.amount};
  }
}

describe('Express<->Web confirmation + idempotency parity', () => {
  let app: RestApplication;
  let http: ReturnType<typeof supertest>;
  let web: FetchHost;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(SafeController);
    await app.start();
    const server = await app.restServer;
    http = supertest(server.url);
    web = server.fetchHandler();
  });

  afterAll(async () => {
    await app.stop();
  });

  // --- Express-surface drivers -------------------------------------------
  async function expressDanger(
    body: unknown,
    token?: string,
  ): Promise<{
    status: number;
    body: {
      error?: {code?: string; confirmationToken?: string};
      deleted?: string;
    };
  }> {
    let req = http.post('/safe/danger');
    if (token) req = req.set('x-confirmation-token', token);
    const r = await req.send(body as object);
    return {status: r.status, body: r.body};
  }

  // --- Web-surface drivers -----------------------------------------------
  async function webDanger(
    body: unknown,
    token?: string,
  ): Promise<{
    status: number;
    body: {
      error?: {code?: string; confirmationToken?: string};
      deleted?: string;
    };
    replayed?: string | null;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (token) headers['x-confirmation-token'] = token;
    const r = await web.fetch(
      new Request('http://x/safe/danger', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    );
    return {
      status: r.status,
      body: (await r.json()) as {
        error?: {code?: string; confirmationToken?: string};
        deleted?: string;
      },
    };
  }

  describe('confirm:', () => {
    it('first call: identical 409 confirmation_required + token on both surfaces', async () => {
      const e = await expressDanger({target: 'prod-db'});
      const w = await webDanger({target: 'prod-db'});
      expect(e.status).toBe(409);
      expect(w.status).toBe(409);
      expect(e.body.error?.code).toBe('confirmation_required');
      expect(w.body.error?.code).toBe('confirmation_required');
      expect(e.body.error?.confirmationToken).toBeTruthy();
      expect(w.body.error?.confirmationToken).toBeTruthy();
      // Same envelope shape (codes/keys), tokens differ (single-use UUIDs).
      expect(Object.keys(w.body.error!).sort()).toEqual(
        Object.keys(e.body.error!).sort(),
      );
    });

    it('identical retry with the issued token executes on both surfaces', async () => {
      // Express round-trip (its own token).
      const e1 = await expressDanger({target: 'a'});
      const e2 = await expressDanger(
        {target: 'a'},
        e1.body.error!.confirmationToken,
      );
      expect(e2.status).toBe(200);
      expect(e2.body).toEqual({deleted: 'a'});

      // Web round-trip (its own token).
      const w1 = await webDanger({target: 'a'});
      const w2 = await webDanger(
        {target: 'a'},
        w1.body.error!.confirmationToken,
      );
      expect(w2.status).toBe(200);
      expect(w2.body).toEqual({deleted: 'a'});

      // Byte-identical successful bodies across surfaces.
      expect(w2.body).toEqual(e2.body);
    });

    it('tampered payload → identical 409 confirmation_invalid on both surfaces', async () => {
      const e1 = await expressDanger({target: 'staging'});
      const e2 = await expressDanger(
        {target: 'prod-db'},
        e1.body.error!.confirmationToken,
      );
      expect(e2.status).toBe(409);
      expect(e2.body.error?.code).toBe('confirmation_invalid');

      const w1 = await webDanger({target: 'staging'});
      const w2 = await webDanger(
        {target: 'prod-db'},
        w1.body.error!.confirmationToken,
      );
      expect(w2.status).toBe(409);
      expect(w2.body.error?.code).toBe('confirmation_invalid');
    });
  });

  describe('idempotency:', () => {
    it('repeated key replays the original result on the Express surface (handler ran once)', async () => {
      const before = chargeRuns;
      const a = await http
        .post('/safe/charge')
        .set('idempotency-key', 'exp-1')
        .send({amount: 10});
      const b = await http
        .post('/safe/charge')
        .set('idempotency-key', 'exp-1')
        .send({amount: 10});
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(b.headers['idempotency-replayed']).toBe('true');
      expect(a.headers['idempotency-replayed']).toBeUndefined();
      expect(chargeRuns - before).toBe(1); // exactly one execution
    });

    it('repeated key replays the original result on the Web surface (handler ran once)', async () => {
      const before = chargeRuns;
      const send = (key: string): Promise<Response> =>
        web.fetch(
          new Request('http://x/safe/charge', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify({amount: 10}),
          }),
        );
      const a = await send('web-1');
      const b = await send('web-1');
      const aBody = await a.json();
      const bBody = await b.json();
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(bBody).toEqual(aBody);
      // The replayed header is surfaced via the shared responseHeaders collector.
      expect(a.headers.get('idempotency-replayed')).toBeNull();
      expect(b.headers.get('idempotency-replayed')).toBe('true');
      expect(chargeRuns - before).toBe(1); // exactly one execution
    });
  });
});
