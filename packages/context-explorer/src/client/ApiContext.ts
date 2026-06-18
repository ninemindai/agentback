// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createContext, useContext} from 'react';
import {makeApi, type ContextApi} from './api';

// The context-explorer API for the current mount, supplied by App. Children
// (e.g. RawTree) read it instead of importing a fixed-base singleton, so the
// panel works under any apiBase (standalone or inside the console).
const ApiContext = createContext<ContextApi>(makeApi('/context-explorer/api'));

export const ApiProvider = ApiContext.Provider;

export function useApi(): ContextApi {
  return useContext(ApiContext);
}
