// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {
  InMemoryConfirmationStore,
  InMemoryIdempotencyStore,
  stableStringify,
} from '@agentback/common';
import {RestApplication} from '../../rest.application.js';
import {AX_SECTION_TAG} from '../../ax.js';

const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string()});
const DeleteOut = z.object({deleted: z.string()});
const ChargeIn = z.object({amount: z.number().positive()});
const ChargeOut = z.object({chargeId: z.string(), amount: z.number()});

let chargeCounter = 0;

@api({basePath: '/agent'})
class AgentContractController {
  @post('/echo', {
    body: EchoIn,
    response: EchoOut,
    summary: 'Echo the text back',
  })
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text};
  }

  @post('/danger', {
    body: z.object({target: z.string()}),
    response: DeleteOut,
    confirm: true,
  })
  async danger(input: {
    body: {target: string};
  }): Promise<z.infer<typeof DeleteOut>> {
    return {deleted: input.body.target};
  }

  @post('/charge', {
    body: ChargeIn,
    response: ChargeOut,
    idempotency: true,
  })
  async charge(input: {
    body: z.infer<typeof ChargeIn>;
  }): Promise<z.infer<typeof ChargeOut>> {
    chargeCounter += 1;
    return {chargeId: `ch_${chargeCounter}`, amount: input.body.amount};
  }

  @post('/charge-strict', {
    body: ChargeIn,
    response: ChargeOut,
    idempotency: {required: true},
  })
  async chargeStrict(input: {
    body: z.infer<typeof ChargeIn>;
  }): Promise<z.infer<typeof ChargeOut>> {
    chargeCounter += 1;
    return {chargeId: `ch_${chargeCounter}`, amount: input.body.amount};
  }

  @get('/plain', {response: z.object({ok: z.boolean()})})
  async plain(): Promise<{ok: boolean}> {
    return {ok: true};
  }
}

describe('agent contract (integration)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(AgentContractController);
    app
      .bind('ax.sections.test')
      .to({title: 'Custom section', body: 'Contributed by a component.'})
      .tag(AX_SECTION_TAG);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => {
    await app.stop();
  });

  describe('error envelope (L-2)', () => {
    it('body validation failures carry code/issues/schema/retryable/hint', async () => {
      const r = await client.post('/agent/echo').send({text: ''}).expect(422);
      const err = r.body.error;
      expect(err.code).toBe('invalid_body');
      expect(err.statusCode).toBe(422);
      expect(err.retryable).toBe(true);
      expect(err.hint).toMatch(/Fix the listed issues/);
      expect(err.issues[0]).toMatchObject({path: ['text']});
      // Back-compat: `details` mirrors `issues`.
      expect(err.details).toEqual(err.issues);
      // The violated section's JSON Schema is inlined.
      expect(err.schema).toMatchObject({
        type: 'object',
        properties: {text: {type: 'string'}},
      });
    });
  });

  describe('AX artifacts (L-1)', () => {
    it('serves /llms.txt with the endpoint index and contributed sections', async () => {
      const r = await client.get('/llms.txt').expect(200);
      expect(r.headers['content-type']).toMatch(/text\/plain/);
      expect(r.text).toMatch(/^# /);
      expect(r.text).toContain('`POST /agent/echo` — Echo the text back');
      expect(r.text).toContain('`GET /agent/plain`');
      expect(r.text).toContain('## Error contract');
      expect(r.text).toContain('## Custom section');
      expect(r.text).toContain('Contributed by a component.');
    });

    it('serves /llms-full.txt with inlined schemas', async () => {
      const r = await client.get('/llms-full.txt').expect(200);
      expect(r.text).toContain('### `POST /agent/echo`');
      expect(r.text).toContain('Request body (application/json):');
      expect(r.text).toMatch(/"text"/);
      expect(r.text).toContain('Response 200');
    });
  });

  describe('confirm: routes (L-4)', () => {
    it('refuses the first call with 409 + token; the identical retry executes', async () => {
      const first = await client
        .post('/agent/danger')
        .send({target: 'prod-db'})
        .expect(409);
      expect(first.body.error.code).toBe('confirmation_required');
      expect(first.body.error.retryable).toBe(true);
      const token = first.body.error.confirmationToken;
      expect(token).toBeTruthy();

      const second = await client
        .post('/agent/danger')
        .set('x-confirmation-token', token)
        .send({target: 'prod-db'})
        .expect(200);
      expect(second.body).toEqual({deleted: 'prod-db'});
    });

    it('a confirmed call must be byte-identical to the proposed one', async () => {
      const first = await client
        .post('/agent/danger')
        .send({target: 'staging'})
        .expect(409);
      const token = first.body.error.confirmationToken;

      const tampered = await client
        .post('/agent/danger')
        .set('x-confirmation-token', token)
        .send({target: 'prod-db'})
        .expect(409);
      expect(tampered.body.error.code).toBe('confirmation_invalid');
    });

    it('tokens are single-use', async () => {
      const first = await client
        .post('/agent/danger')
        .send({target: 'cache'})
        .expect(409);
      const token = first.body.error.confirmationToken;
      await client
        .post('/agent/danger')
        .set('x-confirmation-token', token)
        .send({target: 'cache'})
        .expect(200);
      const replay = await client
        .post('/agent/danger')
        .set('x-confirmation-token', token)
        .send({target: 'cache'})
        .expect(409);
      expect(replay.body.error.code).toBe('confirmation_invalid');
    });

    it('documents the flow in the OpenAPI spec', async () => {
      const spec = (await client.get('/openapi.json').expect(200)).body;
      const op = spec.paths['/agent/danger'].post;
      expect(op['x-confirmation-required']).toBe(true);
      expect(
        op.parameters.some(
          (p: {name: string}) => p.name === 'x-confirmation-token',
        ),
      ).toBe(true);
    });
  });

  describe('idempotency: routes (L-4)', () => {
    it('replays the original result for a repeated key', async () => {
      const a = await client
        .post('/agent/charge')
        .set('idempotency-key', 'key-1')
        .send({amount: 10})
        .expect(200);
      const b = await client
        .post('/agent/charge')
        .set('idempotency-key', 'key-1')
        .send({amount: 10})
        .expect(200);
      expect(b.body).toEqual(a.body);
      expect(b.headers['idempotency-replayed']).toBe('true');
      expect(a.headers['idempotency-replayed']).toBeUndefined();

      const c = await client
        .post('/agent/charge')
        .set('idempotency-key', 'key-2')
        .send({amount: 10})
        .expect(200);
      expect(c.body.chargeId).not.toBe(a.body.chargeId);
    });

    it('runs normally without a key unless required', async () => {
      const a = await client
        .post('/agent/charge')
        .send({amount: 5})
        .expect(200);
      const b = await client
        .post('/agent/charge')
        .send({amount: 5})
        .expect(200);
      expect(b.body.chargeId).not.toBe(a.body.chargeId);
    });

    it('rejects a missing key on {required: true} routes', async () => {
      const r = await client
        .post('/agent/charge-strict')
        .send({amount: 5})
        .expect(400);
      expect(r.body.error.code).toBe('idempotency_key_required');
      expect(r.body.error.hint).toMatch(/idempotency-key/);
    });

    it('documents the idempotency-key header in the OpenAPI spec', async () => {
      const spec = (await client.get('/openapi.json').expect(200)).body;
      const op = spec.paths['/agent/charge-strict'].post;
      const param = op.parameters.find(
        (p: {name: string}) => p.name === 'idempotency-key',
      );
      expect(param).toMatchObject({in: 'header', required: true});
    });
  });

  describe('safety stores (unit-level)', () => {
    it('stableStringify is key-order independent', () => {
      expect(stableStringify({b: 1, a: [2, {d: 3, c: 4}]})).toBe(
        stableStringify({a: [2, {c: 4, d: 3}], b: 1}),
      );
    });

    it('confirmation tokens expire', async () => {
      const store = new InMemoryConfirmationStore();
      const token = store.issue('scope', 'fp', 1);
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(store.verify(token, 'scope', 'fp')).toBe(false);
    });

    it('idempotency does not cache failures', async () => {
      const store = new InMemoryIdempotencyStore();
      let calls = 0;
      const failing = async () => {
        calls += 1;
        throw new Error('boom');
      };
      await expect(store.execute('k', failing)).rejects.toThrow('boom');
      await expect(store.execute('k', failing)).rejects.toThrow('boom');
      expect(calls).toBe(2);
      const ok = await store.execute('k', async () => 'fine');
      expect(ok).toEqual({replayed: false, result: 'fine'});
    });

    it('concurrent calls with one key share a single execution', async () => {
      const store = new InMemoryIdempotencyStore();
      let calls = 0;
      const slow = async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return `result-${calls}`;
      };
      const [a, b] = await Promise.all([
        store.execute('k2', slow),
        store.execute('k2', slow),
      ]);
      expect(calls).toBe(1);
      expect(a.result).toBe('result-1');
      expect(b.result).toBe('result-1');
      expect(a.replayed || b.replayed).toBe(true);
    });
  });
});
