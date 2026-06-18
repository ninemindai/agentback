// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {expect} from 'vitest';

import {loggers} from '@agentback/common';
import HttpErrors from 'http-errors';
import {ExpressMiddlewareFactory, MIDDLEWARE_CONTEXT} from '../../index.js';
import {getMiddlewareContext} from '@agentback/middleware';
import {SpyConfig} from './spy-config.js';

const log = loggers('loopback:middleware:spy');

/**
 * An Express middleware factory function that creates a handler to spy on
 * requests
 */
const spyMiddlewareFactory: ExpressMiddlewareFactory<SpyConfig> = config => {
  const options: SpyConfig = {action: 'log', ...config};
  return function spy(req, res, next) {
    // MIDDLEWARE_CONTEXT is a symbol key; vitest's toHaveProperty takes
    // string paths only, so check directly.
    expect(
      (req as unknown as Record<symbol, unknown>)[MIDDLEWARE_CONTEXT],
    ).toBeDefined();
    expect(getMiddlewareContext(req)?.request).toBe(req);
    log.debug('config', options);
    switch (options?.action) {
      case 'mock':
        log.debug('spy - MOCK');
        res.set('x-spy-mock', `${req.method} ${req.path}`);
        res.send('Hello, Spy');
        break;
      case 'reject':
        log.debug('spy - REJECT');
        res.set('x-spy-reject', `${req.method} ${req.path}`);
        next(new HttpErrors.BadRequest('Request rejected by spy'));
        break;
      default:
        log.debug('spy - LOG');
        res.set('x-spy-log', `${req.method} ${req.path}`);
        next();
        break;
    }
  };
};

export default spyMiddlewareFactory;
