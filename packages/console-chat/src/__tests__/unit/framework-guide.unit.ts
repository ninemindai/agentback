// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {FRAMEWORK_GUIDE} from '../../framework-guide.js';

describe('FRAMEWORK_GUIDE (embedded agentback skill)', () => {
  it('embeds the skill body with frontmatter stripped', () => {
    expect(FRAMEWORK_GUIDE.length).toBeGreaterThan(1000);
    // YAML frontmatter (`---\n…\n---`) must be removed — it's skill-discovery
    // metadata, not in-context guidance.
    expect(FRAMEWORK_GUIDE.startsWith('---')).toBe(false);
    expect(FRAMEWORK_GUIDE).not.toContain('\nname: agentback');
  });

  it('contains the framework idioms the dock agent needs', () => {
    expect(FRAMEWORK_GUIDE).toContain('AgentBack');
    expect(FRAMEWORK_GUIDE).toMatch(/@(get|tool|api|mcpServer)/);
  });
});
