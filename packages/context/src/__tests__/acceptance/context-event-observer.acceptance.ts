// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {
  Binding,
  Context,
  ContextEventType,
  ContextObserver,
  filterByTag,
} from '../../index.js';

let app: Context;
let server: Context;

describe('ContextEventObserver', () => {
  let contextObserver: MyObserverForControllers;
  beforeEach(givenControllerObserver);

  it('receives notifications of matching binding events', async () => {
    const controllers = await getControllers();
    // We have server: ServerController, app: AppController
    // NOTE: The controllers are not guaranteed to be ['ServerController`,
    // 'AppController'] as the events are emitted by two context objects and
    // they are processed asynchronously
    expect(controllers).toContainEqual('ServerController');
    expect(controllers).toContainEqual('AppController');
    server.unbind('controllers.ServerController');
    // Now we have app: AppController
    expect(await getControllers()).toEqual(['AppController']);
    app.unbind('controllers.AppController');
    // All controllers are gone from the context chain
    expect(await getControllers()).toEqual([]);
    // Add a new controller - server: AnotherServerController
    givenController(server, 'AnotherServerController');
    expect(await getControllers()).toEqual(['AnotherServerController']);
  });

  class MyObserverForControllers implements ContextObserver {
    controllers: Set<string> = new Set();
    filter = filterByTag('controller');
    observe(event: ContextEventType, binding: Readonly<Binding<unknown>>) {
      if (event === 'bind') {
        this.controllers.add(binding.tagMap.name);
      } else if (event === 'unbind') {
        this.controllers.delete(binding.tagMap.name);
      }
    }
  }

  function givenControllerObserver() {
    givenServerWithinAnApp();
    contextObserver = new MyObserverForControllers();
    server.subscribe(contextObserver);
    givenController(server, 'ServerController');
    givenController(app, 'AppController');
  }

  function givenController(ctx: Context, controllerName: string) {
    class MyController {
      name = controllerName;
    }
    ctx
      .bind(`controllers.${controllerName}`)
      .toClass(MyController)
      .tag('controller', {name: controllerName});
  }

  async function getControllers() {
    return new Promise<string[]>(resolve => {
      // Wrap it inside `setImmediate` to make the events are triggered
      setImmediate(() => resolve(Array.from(contextObserver.controllers)));
    });
  }
});

function givenServerWithinAnApp() {
  app = new Context('app');
  server = new Context(app, 'server');
}
