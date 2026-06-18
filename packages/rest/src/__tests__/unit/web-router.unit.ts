// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Router} from '../../web/router.js';

describe('Router', () => {
  it('matches a literal path', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/health', value: 'h'});
    expect(r.match('GET', '/health')).toEqual({value: 'h', params: {}});
  });

  it('extracts and URL-decodes path params', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/greet/hello/{name}', value: 'g'});
    expect(r.match('GET', '/greet/hello/Ada%20Lovelace')).toEqual({
      value: 'g',
      params: {name: 'Ada Lovelace'},
    });
  });

  it('matches multiple params', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/a/{x}/b/{y}', value: 'v'});
    expect(r.match('GET', '/a/1/b/2')).toEqual({
      value: 'v',
      params: {x: '1', y: '2'},
    });
  });

  it('is method-sensitive but case-insensitive on the verb', () => {
    const r = new Router<string>();
    r.add({method: 'POST', template: '/echo', value: 'e'});
    expect(r.match('post', '/echo')).toEqual({value: 'e', params: {}});
    expect(r.match('GET', '/echo')).toBeUndefined();
  });

  it('returns undefined when nothing matches (non-greedy)', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/health', value: 'h'});
    expect(r.match('GET', '/nope')).toBeUndefined();
  });

  it('does not match on segment-count mismatch', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/a/{x}', value: 'v'});
    expect(r.match('GET', '/a/1/2')).toBeUndefined();
    expect(r.match('GET', '/a')).toBeUndefined();
  });

  it('normalizes trailing slashes', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/health', value: 'h'});
    expect(r.match('GET', '/health/')).toEqual({value: 'h', params: {}});
  });

  it('rejects a structurally duplicate route at registration', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/x/{a}', value: 'first'});
    expect(() =>
      r.add({method: 'GET', template: '/x/{b}', value: 'second'}),
    ).toThrow(/duplicate route/);
  });

  it('prefers a static segment over a param regardless of order', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/users/{id}', value: 'param'});
    r.add({method: 'GET', template: '/users/me', value: 'static'});
    expect(r.match('GET', '/users/me')?.value).toBe('static');
    expect(r.match('GET', '/users/42')?.value).toBe('param');
  });

  it('treats malformed percent-encoding as a non-match (never throws)', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/greet/{name}', value: 'g'});
    expect(r.match('GET', '/greet/%ZZ')).toBeUndefined();
  });

  it('matches the root path', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/', value: 'root'});
    expect(r.match('GET', '/')).toEqual({value: 'root', params: {}});
  });

  it('normalizes the verb case on add() as well as match()', () => {
    const r = new Router<string>();
    r.add({method: 'post', template: '/echo', value: 'e'});
    expect(r.match('POST', '/echo')?.value).toBe('e');
    expect(r.match('GET', '/echo')).toBeUndefined();
  });

  it('captures a param value containing a dot (param regex is not greedy across /)', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/files/{name}', value: 'f'});
    expect(r.match('GET', '/files/a.txt')).toEqual({
      value: 'f',
      params: {name: 'a.txt'},
    });
  });

  it('escapes regex-special chars in literal segments (dot is literal, not wildcard)', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/v1.0/ping', value: 'p'});
    // The literal dot must match a literal '.', not any char.
    expect(r.match('GET', '/v1.0/ping')?.value).toBe('p');
    // If the dot were treated as a regex wildcard, '/v1X0/ping' would match —
    // it must not.
    expect(r.match('GET', '/v1X0/ping')).toBeUndefined();
  });
});
