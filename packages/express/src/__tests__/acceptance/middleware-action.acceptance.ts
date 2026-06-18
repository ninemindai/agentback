// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, afterEach, expect} from 'vitest';

import {registerExpressMiddleware} from '../../index.js';
import {SpyAction} from '../fixtures/spy-config.js';
import {spy, SpyConfig, TestFunction, TestHelper} from './test-helpers.js';

describe('Middleware request interceptor', () => {
  let helper: TestHelper;

  function runTests(action: SpyAction, testFn: TestFunction) {
    describe(`registerMiddleware - ${action}`, () => {
      const spyConfig: SpyConfig = {action};
      beforeEach(givenTestApp);
      afterEach(() => helper?.stop());

      it('registers a middleware interceptor provider class by factory', () => {
        const binding = registerExpressMiddleware(helper.app, spy, spyConfig);
        return testFn(binding);
      });

      it('registers a middleware interceptor as handler function', () => {
        const binding = registerExpressMiddleware(helper.app, spy, spyConfig, {
          injectConfiguration: false,
          key: 'interceptors.middleware.spy',
        });
        expect(binding.key).toEqual('interceptors.middleware.spy');
        return testFn(binding);
      });
    });
  }

  runTests('log', binding => helper.testSpyLog(binding));
  runTests('mock', binding => helper.testSpyMock(binding));
  runTests('reject', binding => helper.testSpyReject(binding));

  function givenTestApp() {
    helper = new TestHelper();
    helper.bindController();
    return helper.start();
  }
});
