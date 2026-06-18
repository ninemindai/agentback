// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {runJobQueueConformance} from '../../testing/conformance.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';

runJobQueueConformance('in-memory', () => new InMemoryJobQueue());
