// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {runEventBusConformance} from '../../testing/conformance.js';
import {InMemoryEventBus} from '../../in-memory/in-memory-event-bus.js';

runEventBusConformance('in-memory', () => new InMemoryEventBus());
