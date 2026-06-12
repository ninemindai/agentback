// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {Context, ContextView, filterByTag} from '../../index.js';

let app: Context;
let server: Context;

describe('ContextView', () => {
  let viewOfControllers: ContextView;
  beforeEach(givenViewForControllers);

  it('watches matching bindings', async () => {
    // We have server: ServerController, app: AppController
    expect(await getControllers()).toEqual([
      'ServerController',
      'AppController',
    ]);
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

  function givenViewForControllers() {
    givenServerWithinAnApp();
    viewOfControllers = server.createView(filterByTag('controller'));
    givenController(server, 'ServerController');
    givenController(app, 'AppController');
  }

  function givenController(context: Context, name: string) {
    class MyController {
      name = name;
    }
    context.bind(`controllers.${name}`).toClass(MyController).tag('controller');
  }

  async function getControllers() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await viewOfControllers.values()).map((v: any) => v.name);
  }
});

function givenServerWithinAnApp() {
  app = new Context('app');
  server = new Context(app, 'server');
}
