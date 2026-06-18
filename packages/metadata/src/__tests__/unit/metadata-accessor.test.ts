// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {
  ClassDecoratorFactory,
  MetadataAccessor,
  MetadataInspector,
} from '../../index.js';

describe('MetadataAccessor', () => {
  it('creates an accessor with a string key', () => {
    expect(
      MetadataAccessor.create<string, ClassDecorator>('foo'),
    ).toHaveProperty('key', 'foo');
  });

  it('overrides toString()', () => {
    expect(
      MetadataAccessor.create<object, ClassDecorator>('bar').toString(),
    ).toBe('bar');
  });

  it('can be used to create decorator', () => {
    const nameKey = MetadataAccessor.create<string, ClassDecorator>('name');

    function classDecorator(name: string) {
      return ClassDecoratorFactory.createDecorator<string>(nameKey, name);
    }

    @classDecorator('my-controller')
    class MyController {}

    expect(MetadataInspector.getClassMetadata(nameKey, MyController)).toBe(
      'my-controller',
    );
  });
});
