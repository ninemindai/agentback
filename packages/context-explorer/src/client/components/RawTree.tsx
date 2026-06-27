// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {useEffect, useState} from 'react';
import {type InspectTree} from '../api';
import {useApi} from '../ApiContext';

/** Lazily fetches and pretty-prints the full inspect() tree as JSON. */
export function RawTree() {
  const api = useApi();
  const [tree, setTree] = useState<InspectTree | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fetchInspect().then(setTree, e => setError(String(e)));
  }, [api]);

  if (error) return <p className="err">Failed to load inspect tree: {error}</p>;
  if (!tree) return <p className="empty">Loading…</p>;
  return <pre className="raw">{JSON.stringify(tree, null, 2)}</pre>;
}
