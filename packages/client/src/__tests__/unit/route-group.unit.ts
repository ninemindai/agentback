// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {routeGroup} from '../../route-group.js';

const HelloPath = z.object({name: z.string()});
const Greeting = z.object({greeting: z.string()});

describe('routeGroup', () => {
  it('prepends the prefix to a route path', () => {
    const greet = routeGroup('/greet');
    const hello = greet.get('/hello/{name}', {
      path: HelloPath,
      response: Greeting,
    });
    expect(hello.path).toBe('/greet/hello/{name}');
    expect(hello.method).toBe('GET');
  });

  it('exposes one factory per verb', () => {
    const g = routeGroup('/x');
    expect(g.get('/a').method).toBe('GET');
    expect(g.post('/a').method).toBe('POST');
    expect(g.put('/a').method).toBe('PUT');
    expect(g.patch('/a').method).toBe('PATCH');
    expect(g.delete('/a').method).toBe('DELETE');
    expect(g.head('/a').method).toBe('HEAD');
  });

  it('schemas argument is optional (defaults to {})', () => {
    const ping = routeGroup('/health').get('/ping');
    expect(ping.path).toBe('/health/ping');
    expect(ping.schemas).toEqual({});
  });

  it('normalizes adjacent slashes from prefix and path', () => {
    expect(routeGroup('/x/').get('/a').path).toBe('/x/a');
    expect(routeGroup('/x').get('a').path).toBe('/x/a');
    expect(routeGroup('/x/').get('a').path).toBe('/x/a');
  });

  it('composes nested groups via .group()', () => {
    const api = routeGroup('/api');
    const v1 = api.group('/v1');
    const users = v1.get('/users');
    expect(users.path).toBe('/api/v1/users');

    // The child group is itself nestable.
    const v1admin = v1.group('/admin');
    expect(v1admin.get('/users').path).toBe('/api/v1/admin/users');
  });

  it('produces routes equivalent to a hand-written defineRoute', () => {
    const direct = routeGroup('/g').get('/h/{name}', {
      path: HelloPath,
      response: Greeting,
    });
    expect(direct.schemas).toEqual({path: HelloPath, response: Greeting});
  });
});
