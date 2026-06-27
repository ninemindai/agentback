// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {createContext, useContext} from 'react';
import {makeApi, type SchemaApi} from './api';

// The schema-explorer API for the current mount, supplied by App. Children read
// it instead of importing a fixed-base singleton, so the panel works under any
// apiBase (standalone or inside the console).
const ApiContext = createContext<SchemaApi>(makeApi('/schema-explorer/api'));

export const ApiProvider = ApiContext.Provider;

export function useApi(): SchemaApi {
  return useContext(ApiContext);
}
