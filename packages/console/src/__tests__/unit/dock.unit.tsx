// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {renderToString} from 'react-dom/server';
import {App} from '../../client/App.js';

const base = {basePath: '/console', title: 'c', panels: {}};

describe('console dock slot', () => {
  it('renders no dock when chat is absent', () => {
    const html = renderToString(<App config={base} pages={[]} />);
    expect(html).not.toContain('data-dock');
  });
  it('renders the dock when chat.enabled', () => {
    const cfg = {
      ...base,
      chat: {
        enabled: true,
        apiBase: '/console/chat',
        agents: [{id: 'cc', name: 'Claude Code'}],
      },
    };
    const html = renderToString(<App config={cfg} pages={[]} />);
    expect(html).toContain('data-dock');
  });
});
