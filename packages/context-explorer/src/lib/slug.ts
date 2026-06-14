// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

/** Lowercase, hyphenate a value for use in CSS class tokens. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
