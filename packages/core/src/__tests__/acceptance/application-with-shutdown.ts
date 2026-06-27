// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {promisify} from 'util';
import {Application, LifeCycleObserver} from '../../index.js';
const sleep = promisify(setTimeout);

function main() {
  // Optional argument as the grace period
  const gracePeriod = Number.parseFloat(process.argv[2]);

  class MyTimer implements LifeCycleObserver {
    timer: NodeJS.Timeout;

    start() {
      console.log('start');
      this.timer = setTimeout(() => {
        console.log('timeout');
      }, 30000);
    }

    async stop() {
      console.log('stop');
      clearTimeout(this.timer);
      if (gracePeriod >= 0) {
        // Set a longer sleep to trigger force kill
        await sleep(gracePeriod + 100);
      }
      console.log('stopped');
    }
  }

  const app = new Application({
    shutdown: {signals: ['SIGTERM', 'SIGINT'], gracePeriod},
  });
  app.lifeCycleObserver(MyTimer);
  app.start().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

// ESM equivalent of CJS `require.main === module`: run only when this
// file is the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
