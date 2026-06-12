# @agentback/metadata

> Decorator metadata utilities — the reflection layer that all higher-level DI
> decorators are built on.

ESM port of [`@loopback/metadata`](https://github.com/loopbackio/loopback-next/tree/master/packages/metadata).
Provides factories for authoring class/method/property/parameter decorators,
a high-level inspector for reading them back, and a namespaced wrapper around
the `reflect-metadata` API.

## What it provides

- `ClassDecoratorFactory`, `MethodDecoratorFactory`, `PropertyDecoratorFactory`,
  `ParameterDecoratorFactory` — base factory classes for writing decorators that
  merge and inherit metadata correctly.
- `MetadataInspector` — high-level API to read class, method, property, and
  parameter metadata; works with or without the prototype chain
  (`ownMetadataOnly`).
- `MetadataAccessor<T, D>` — strongly-typed token used as metadata keys so
  storage and retrieval share the same type parameter.
- `Reflector` / `NamespacedReflect` — `reflect-metadata` wrappers that prefix
  all keys with a `loopback:` namespace, preventing collisions with other
  libraries that write to the same `Reflect` store.
- `DecoratorType`, `MetadataKey`, `MetadataMap`, `DesignTimeMethodMetadata` —
  supporting types.

## Usage

```ts
import {
  ClassDecoratorFactory,
  MetadataAccessor,
  MetadataInspector,
} from '@agentback/metadata';

// 1. Define a typed key for your decorator
const MY_KEY = MetadataAccessor.create<{role: string}, ClassDecorator>(
  'my:role',
);

// 2. Write the decorator using the factory
function role(r: string): ClassDecorator {
  return ClassDecoratorFactory.createDecorator(MY_KEY, {role: r});
}

// 3. Apply it
@role('admin')
class AdminController {}

// 4. Read it back
const meta = MetadataInspector.getClassMetadata(MY_KEY, AdminController);
// meta -> {role: 'admin'}
```

## Layering

Depends on: nothing (leaf package — only `reflect-metadata`, `lodash-es`, and
`debug`).  
This is the lowest level of the framework stack; every other `@agentback/*`
package that uses decorators imports from here (usually re-exported through
`@agentback/context`).
