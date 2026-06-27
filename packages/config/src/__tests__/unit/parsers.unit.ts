// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parseConfigText, parseJsonc} from '../../parsers.js';

describe('parseJsonc', () => {
  it('parses JSON with comments and trailing commas', () => {
    const text = `{
      // line comment
      "a": 1,
      /* block */
      "b": [2, 3,],
    }`;
    expect(parseJsonc(text)).toEqual({a: 1, b: [2, 3]});
  });

  it('reports the filename in errors', () => {
    expect(() => parseJsonc('{ "a": ,', 'broken.jsonc')).toThrow(
      /broken\.jsonc/,
    );
  });
});

describe('parseConfigText', () => {
  it('dispatches .yaml to the YAML parser', () => {
    const yaml = 'database:\n  host: localhost\n  port: 5432\n';
    expect(parseConfigText(yaml, 'db.yaml')).toEqual({
      database: {host: 'localhost', port: 5432},
    });
  });

  it('dispatches .yml the same way', () => {
    expect(parseConfigText('a: 1', 'x.yml')).toEqual({a: 1});
  });

  it('dispatches .json and .jsonc to the JSONC parser', () => {
    expect(parseConfigText('{"a": 1}', 'x.json')).toEqual({a: 1});
    expect(parseConfigText('{"a": 1,}', 'x.jsonc')).toEqual({a: 1});
  });

  it('falls back to JSONC for unknown extensions', () => {
    expect(parseConfigText('{"a": 1}', 'noext')).toEqual({a: 1});
  });

  it('reports the filename on YAML errors', () => {
    expect(() => parseConfigText('a: : :', 'broken.yaml')).toThrow(
      /broken\.yaml/,
    );
  });
});
