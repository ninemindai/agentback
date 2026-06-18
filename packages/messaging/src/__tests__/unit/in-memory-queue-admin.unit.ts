// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {runQueueAdminConformance} from '../../testing/conformance.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';
import {InMemoryQueueAdmin} from '../../in-memory/in-memory-queue-admin.js';

runQueueAdminConformance('in-memory', () => {
  const queue = new InMemoryJobQueue();
  const admin = new InMemoryQueueAdmin(queue.backingStore);
  return {admin, queue};
});
