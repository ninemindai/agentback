// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {renderToString} from 'react-dom/server';
import {App} from '../../client/App.js';
import type {ConsolePage} from '../../client/types.js';

const base = {basePath: '/console', title: 'c', panels: {p: {apiBase: '/x'}}};

// A panel that renders whatever reloadNonce it receives, so we can assert the
// shell forwarded it (render-time wiring; effects do not run in renderToString).
const probe: ConsolePage = {
  id: 'p',
  title: 'P',
  icon: '*',
  order: 10,
  route: '/p',
  liveRefresh: 'prop',
  component: ({reloadNonce}: {apiBase: string; reloadNonce?: number}) => (
    <span data-nonce={String(reloadNonce ?? 'none')}>panel</span>
  ),
};

describe('console live-reflection wiring', () => {
  it('forwards reloadNonce (initial 0) to a liveRefresh:prop panel', () => {
    const html = renderToString(<App config={base} pages={[probe]} />);
    expect(html).toContain('data-nonce="0"');
  });

  it('renders the panel content', () => {
    const html = renderToString(<App config={base} pages={[probe]} />);
    expect(html).toContain('panel');
  });
});
