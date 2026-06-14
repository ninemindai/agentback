// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {Facets} from '../../lib/selectors';
import {slug} from '../../lib/slug';

export interface FacetSelection {
  kind: Set<string>;
  scope: Set<string>;
  type: Set<string>;
  tag: Set<string>;
  extensionPoint: Set<string>;
  lifeCycleGroup: Set<string>;
  context: Set<string>;
}

interface Props {
  facets: Facets;
  selection: FacetSelection;
  onToggle: (facet: keyof FacetSelection, value: string) => void;
}

const GROUPS: {
  facet: keyof FacetSelection;
  label: string;
  map: keyof Facets;
}[] = [
  {facet: 'kind', label: 'Kind', map: 'kind'},
  {facet: 'scope', label: 'Scope', map: 'scope'},
  {facet: 'type', label: 'Type', map: 'type'},
  {facet: 'extensionPoint', label: 'Extension point', map: 'extensionPoint'},
  {facet: 'lifeCycleGroup', label: 'Lifecycle group', map: 'lifeCycleGroup'},
  {facet: 'context', label: 'Context', map: 'context'},
  {facet: 'tag', label: 'Tag', map: 'tag'},
];

export function FacetNav({facets, selection, onToggle}: Props) {
  return (
    <nav className="facets">
      {GROUPS.map(g => {
        const entries = [...facets[g.map].entries()].sort(
          (a, b) => b[1] - a[1],
        );
        if (!entries.length) return null;
        return (
          <section key={g.facet} className="facetgroup">
            <h3>{g.label}</h3>
            {entries.map(([value, count]) => {
              const on = selection[g.facet].has(value);
              return (
                <button
                  key={value}
                  className={'facet' + (on ? ' on' : '')}
                  onClick={() => onToggle(g.facet, value)}
                >
                  <span className={'fdot ' + g.facet + '-' + slug(value)} />
                  <span className="flabel">{value}</span>
                  <span className="fcount">{count}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}
