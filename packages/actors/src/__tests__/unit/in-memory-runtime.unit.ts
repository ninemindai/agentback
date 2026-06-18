// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {runActorRuntimeConformance} from '../../testing/conformance.js';
import {InMemoryActorRuntime} from '../../in-memory-runtime.js';

runActorRuntimeConformance('in-memory', () => new InMemoryActorRuntime());
