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
  {facet: 'context', label: 'Context'},
  {facet: 'kind', label: 'Kind'},
  {facet: 'type', label: 'Type'},
  {facet: 'scope', label: 'Scope'},
  {facet: 'extensionPoint', label: 'Extension point'},
  {facet: 'lifeCycleGroup', label: 'Lifecycle group'},
  {facet: 'tag', label: 'Tag'},
];

/**
 * Fixed display order for the `kind` facet values (other facets stay
 * sorted by count). Tokens match `model.ts`'s pushed kind strings; any
 * value not listed here (e.g. `extensionPoint`) sorts to the end.
 */
const KIND_ORDER = [
  'component',
  'lifeCycleObserver',
  'extension',
  'config',
  'server',
  'controller',
  'mcpServer',
];

const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
};

export function FacetNav({facets, selected, onPick}: Props) {
  return (
    <nav className="facets">
      {GROUPS.map(g => {
        const entries = [...facets[g.facet].entries()].sort((a, b) =>
          g.facet === 'kind'
            ? kindRank(a[0]) - kindRank(b[0])
            : b[1] - a[1],
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
