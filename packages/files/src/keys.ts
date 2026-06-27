// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import type {FileStore} from './ports.js';

/** DI key for the active {@link FileStore}. Bind an adapter; inject to use. */
export const FILE_STORE = BindingKey.create<FileStore>('files.store');
