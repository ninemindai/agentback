// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// A deterministic mock model so the example runs with no network and no API
// key: first step calls the `forecast` tool, second step answers with text.
// Swap in a real provider (e.g. @ai-sdk/anthropic) and everything else in
// main.ts stays the same.

import {MockLanguageModelV4} from 'ai/test';

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {total: 20, text: 20, reasoning: undefined},
};

export function mockForecastModel(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'call-1',
              toolName: 'forecast',
              input: JSON.stringify({city: 'Tokyo'}),
            },
          ],
          finishReason: {unified: 'tool-calls' as const, raw: undefined},
          usage,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Tokyo is 21°C with clear skies.',
          },
        ],
        finishReason: {unified: 'stop' as const, raw: undefined},
        usage,
        warnings: [],
      };
    },
  });
}
