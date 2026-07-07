// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mcpServer, tool} from '@agentback/mcp';
import {z} from 'zod';

// Ordinary @tool classes — nothing CLI-specific. The SAME schemas already
// serve MCP inputSchema, and would serve a REST route / OpenAPI / the AI SDK
// projection unchanged. @agentback/command adds argv/stdout as one more view.

const ForecastIn = z.object({
  city: z.string().min(1).describe('City name'),
  // Authored z.number() for a JSON body — the CLI coerces the string argv.
  days: z.number().int().min(1).max(7).default(1).describe('Days ahead'),
});
const ForecastOut = z.object({
  city: z.string(),
  days: z.number(),
  tempC: z.number(),
  summary: z.string(),
});

const GeocodeIn = z.object({query: z.string().min(1).describe('Place to look up')});
const GeocodeOut = z.object({lat: z.number(), lon: z.number()});

@mcpServer()
export class WeatherTools {
  @tool('forecast', {
    description: 'Weather forecast for a city.',
    input: ForecastIn,
    output: ForecastOut,
  })
  forecast(input: z.infer<typeof ForecastIn>): z.infer<typeof ForecastOut> {
    return {
      city: input.city,
      days: input.days,
      tempC: 18 + input.days,
      summary: 'clear',
    };
  }

  @tool('geocode', {
    description: 'Look up coordinates for a place.',
    input: GeocodeIn,
    output: GeocodeOut,
  })
  geocode(input: z.infer<typeof GeocodeIn>): z.infer<typeof GeocodeOut> {
    // Deterministic stub so the example runs with zero external calls.
    const h = [...input.query].reduce((a, c) => a + c.charCodeAt(0), 0);
    return {lat: (h % 180) - 90, lon: (h % 360) - 180};
  }
}
