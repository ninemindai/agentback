// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Programmatic entry point. `create-agentback` is primarily a `bin`, but it is
 * also the single source of truth for scaffolding — `@agentback/cli`'s
 * `agentback new` delegates here rather than duplicating templates, and
 * `skills/agentback/SKILL.md` documents this import for tool authors.
 */
export {
  scaffold,
  detectPackageManager,
  TEMPLATES,
  type ScaffoldOptions,
  type ScaffoldResult,
  type TemplateName,
} from './scaffold.js';

export {
  CAPABILITIES,
  capabilityNames,
  findCapability,
  type Capability,
} from './capabilities.js';
