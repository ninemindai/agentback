// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {Facets} from '../../lib/selectors';
import {slug} from '../../lib/slug';

/** The single active facet filter, or `null` when nothing is selected. */
export type FacetChoice = {facet: keyof Facets; value: string} | null;

interface Props {
  facets: Facets;
  /** The one active filter across the whole panel (single-select). */
  selected: FacetChoice;
  /** Pick a value; picking the active one again clears the filter. */
  onPick: (facet: keyof Facets, value: string) => void;
}

const GROUPS: {facet: keyof Facets; label: string}[] = [
  {facet: 'kind', label: 'Kind'},
  {facet: 'scope', label: 'Scope'},
  {facet: 'type', label: 'Type'},
  {facet: 'extensionPoint', label: 'Extension point'},
  {facet: 'lifeCycleGroup', label: 'Lifecycle group'},
  {facet: 'context', label: 'Context'},
  {facet: 'tag', label: 'Tag'},
];

export function FacetNav({facets, selected, onPick}: Props) {
  return (
    <nav className="facets">
      {GROUPS.map(g => {
        const entries = [...facets[g.facet].entries()].sort(
          (a, b) => b[1] - a[1],
        );
        if (!entries.length) return null;
        return (
          <section key={g.facet} className="facetgroup">
            <h3>{g.label}</h3>
            {entries.map(([value, count]) => {
              const on =
                selected?.facet === g.facet && selected?.value === value;
              return (
                <button
                  key={value}
                  className={'facet' + (on ? ' on' : '')}
                  onClick={() => onPick(g.facet, value)}
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
