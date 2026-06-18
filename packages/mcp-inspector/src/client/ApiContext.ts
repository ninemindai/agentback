// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createContext, useContext} from 'react';
import {localApi, type Api} from './api';

// The active backend (local in-process server, or a remote mcp-connect target).
// App swaps the provided value when the user switches targets.
const ApiContext = createContext<Api>(localApi(''));

export const ApiProvider = ApiContext.Provider;

export function useApi(): Api {
  return useContext(ApiContext);
}
