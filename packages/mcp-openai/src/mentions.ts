// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {toolFragment, type ToolFragment} from '@agentback/mcp';
import {z} from 'zod';
import {accepts, OPENAI_EXTENSIONS_META_KEY} from './shared.js';

const IconSchema = z.object({
  src: z.string(),
  mimeType: z.string().optional(),
  sizes: z.array(z.string()).optional(),
});

/** The arguments of an at-mention search: the typeahead text (may be empty). */
export const MentionSearchIn = z.object({query: z.string()});

/** A resource link (MCP `ResourceLink`) offered as a mention. */
export const MentionResourceLink = z.object({
  type: z.literal('resource_link'),
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  icons: z.array(IconSchema).optional(),
});

/** An app resource offered as a mention. */
export const MentionResource = z.object({
  type: z.literal('resource'),
  resourceUri: z.string().regex(/\S/),
  title: z.string().regex(/\S/),
  subtitle: z.string().regex(/\S/).optional(),
  icons: z.array(IconSchema).optional(),
});

/** The result of an at-mention search. */
export const MentionSearchOut = z.object({
  items: z.array(
    z.discriminatedUnion('type', [MentionResourceLink, MentionResource]),
  ),
});

/**
 * Marks a tool as ChatGPT's composer at-mention search
 * (`_meta["openai/extensions"]["mentions/search"]`). Adds `readOnlyHint` and
 * `ui.visibility: ['app']` (the spec requires the host-only visibility), and
 * checks at decoration that the tool takes {@link MentionSearchIn} and
 * declares an output accepting {@link MentionSearchOut}.
 *
 * @example
 *   @tool('search_parts', {
 *     input: MentionSearchIn,
 *     output: MentionSearchOut,
 *     extend: [mentionSearch()],
 *   })
 *
 * @experimental Tracks OpenAI's MCP extensions spec (0.1.x).
 */
export function mentionSearch(): ToolFragment {
  return toolFragment({
    meta: {[OPENAI_EXTENSIONS_META_KEY]: {'mentions/search': {}}},
    ui: {visibility: ['app']},
    annotations: {readOnlyHint: true},
    check: resolved => {
      if (!resolved.input || !accepts(resolved.input, {query: ''})) {
        throw new Error(
          'a mention-search tool takes {query: string} — use input: MentionSearchIn',
        );
      }
      if (!resolved.output || !accepts(resolved.output, {items: []})) {
        throw new Error(
          'a mention-search tool returns {items: [...]} — use output: MentionSearchOut',
        );
      }
    },
  });
}
