// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  DecoratorFactory,
  InspectionOptions,
  MetadataAccessor,
  MetadataInspector,
  MetadataMap,
  ParameterDecoratorFactory,
  PropertyDecoratorFactory,
  Reflector,
} from '@agentback/metadata';
import {Binding, BindingTag} from './binding.js';
import {
  BindingFilter,
  BindingSelector,
  filterByTag,
  isBindingAddress,
  isBindingTagFilter,
} from './binding-filter.js';
import {BindingAddress, BindingKey} from './binding-key.js';
import {BindingComparator} from './binding-sorter.js';
import {BindingCreationPolicy, Context} from './context.js';
import {ContextView, createViewGetter} from './context-view.js';
import {JSONObject} from './json-types.js';
import {ResolutionOptions, ResolutionSession} from './resolution-session.js';
import {BoundValue, Constructor, ValueOrPromise} from './value-promise.js';

const INJECT_PARAMETERS_KEY = MetadataAccessor.create<
  Injection,
  ParameterDecorator
>('inject:parameters');

const INJECT_PROPERTIES_KEY = MetadataAccessor.create<
  Injection,
  PropertyDecorator
>('inject:properties');

// A key to cache described argument injections
const INJECT_METHODS_KEY = MetadataAccessor.create<Injection, MethodDecorator>(
  'inject:methods',
);

// TODO(rfeng): We may want to align it with `ValueFactory` interface that takes
// an argument of `ResolutionContext`.
/**
 * A function to provide resolution of injected values.
 *
 * @example
 * ```ts
 * const resolver: ResolverFunction = (ctx, injection, session) {
 *   return session.currentBinding?.key;
 * }
 * ```
 */
export interface ResolverFunction {
  (
    ctx: Context,
    injection: Readonly<Injection>,
    session: ResolutionSession,
  ): ValueOrPromise<BoundValue>;
}

/**
 * An object to provide metadata for `@inject`
 */
export interface InjectionMetadata extends Omit<ResolutionOptions, 'session'> {
  /**
   * Name of the decorator function, such as `@inject` or `@inject.setter`.
   * It's usually set by the decorator implementation.
   */
  decorator?: string;
  /**
   * Optional comparator for matched bindings
   */
  bindingComparator?: BindingComparator;
  /**
   * Other attributes
   */
  [attribute: string]: BoundValue;
}

/**
 * Descriptor for an injection point
 */
export interface Injection<ValueType = BoundValue> {
  target: Object;
  member?: string;
  methodDescriptorOrParameterIndex?:
    | TypedPropertyDescriptor<ValueType>
    | number;

  bindingSelector: BindingSelector<ValueType>; // Binding selector
  metadata: InjectionMetadata; // Related metadata
  resolve?: ResolverFunction; // A custom resolve function
}

/**
 * A decorator to annotate method arguments for automatic injection
 * by LoopBack IoC container.
 *
 * @example
 * Usage - Typescript:
 *
 * ```ts
 * class InfoController {
 *   @inject('authentication.user') public userName: string;
 *
 *   constructor(@inject('application.name') public appName: string) {
 *   }
 *   // ...
 * }
 * ```
 *
 * Usage - JavaScript:
 *
 *  - TODO(bajtos)
 *
 * @param bindingSelector - What binding to use in order to resolve the value of the
 * decorated constructor parameter or property.
 * @param metadata - Optional metadata to help the injection
 * @param resolve - Optional function to resolve the injection
 *
 */
export function inject(
  bindingSelector: BindingSelector,
  metadata?: InjectionMetadata,
  resolve?: ResolverFunction,
) {
  if (typeof bindingSelector === 'function' && !resolve) {
    resolve = resolveValuesByFilter;
  }
  const injectionMetadata = Object.assign({decorator: '@inject'}, metadata);
  if (injectionMetadata.bindingComparator && !resolve) {
    throw new Error('Binding comparator is only allowed with a binding filter');
  }
  if (!bindingSelector && typeof resolve !== 'function') {
    throw new Error(
      'A non-empty binding selector or resolve function is required for @inject',
    );
  }
  return function markParameterOrPropertyAsInjected(
    target: Object,
    member: string | undefined,
    methodDescriptorOrParameterIndex?:
      | TypedPropertyDescriptor<BoundValue>
      | number,
  ) {
    if (typeof methodDescriptorOrParameterIndex === 'number') {
      // The decorator is applied to a method parameter
      // Please note propertyKey is `undefined` for constructor
      const paramDecorator: ParameterDecorator =
        ParameterDecoratorFactory.createDecorator<Injection>(
          INJECT_PARAMETERS_KEY,
          {
            target,
            member,
            methodDescriptorOrParameterIndex,
            bindingSelector,
            metadata: injectionMetadata,
            resolve,
          },
          // Do not deep clone the spec as only metadata is mutable and it's
          // shallowly cloned
          {cloneInputSpec: false, decoratorName: injectionMetadata.decorator},
        );
      paramDecorator(target, member!, methodDescriptorOrParameterIndex);
    } else if (member) {
      // Property or method
      if (target instanceof Function) {
        throw new Error(
          '@inject is not supported for a static property: ' +
            DecoratorFactory.getTargetName(target, member),
        );
      }
      if (methodDescriptorOrParameterIndex) {
        // Method
        throw new Error(
          '@inject cannot be used on a method: ' +
            DecoratorFactory.getTargetName(
              target,
              member,
              methodDescriptorOrParameterIndex,
            ),
        );
      }
      const propDecorator: PropertyDecorator =
        PropertyDecoratorFactory.createDecorator<Injection>(
          INJECT_PROPERTIES_KEY,
          {
            target,
            member,
            methodDescriptorOrParameterIndex,
            bindingSelector,
            metadata: injectionMetadata,
            resolve,
          },
          // Do not deep clone the spec as only metadata is mutable and it's
          // shallowly cloned
          {cloneInputSpec: false, decoratorName: injectionMetadata.decorator},
        );
      propDecorator(target, member!);
    } else {
      // It won't happen here as `@inject` is not compatible with ClassDecorator
      /* istanbul ignore next */
      throw new Error(
        '@inject can only be used on a property or a method parameter',
      );
    }
  };
}

/**
 * The function injected by `@inject.getter(bindingSelector)`. It can be used
 * to fetch bound value(s) from the underlying binding(s). The return value will
 * be an array if the `bindingSelector` is a `BindingFilter` function.
 */
export type Getter<T> = () => Promise<T>;

export namespace Getter {
  /**
   * Convert a value into a Getter returning that value.
   * @param value
   */
  export function fromValue<T>(value: T): Getter<T> {
    return () => Promise.resolve(value);
  }
}

/**
 * The function injected by `@inject.setter(bindingKey)`. It sets the underlying
 * binding to a constant value using `binding.to(value)`.
 *
 * @example
 *
 * ```ts
 * setterFn('my-value');
 * ```
 * @param value - The value for the underlying binding
 */
export type Setter<T> = (value: T) => void;

/**
 * Metadata for `@inject.binding`
 */
export interface InjectBindingMetadata extends InjectionMetadata {
  /**
   * Controls how the underlying binding is resolved/created
   */
  bindingCreation?: BindingCreationPolicy;
}

export namespace inject {
  /**
   * Inject a function for getting the actual bound value.
   *
   * This is useful when implementing Actions, where
   * the action is instantiated for Sequence constructor, but some
   * of action's dependencies become bound only after other actions
   * have been executed by the sequence.
   *
   * See also `Getter<T>`.
   *
   * @param bindingSelector - The binding key or filter we want to eventually get
   * value(s) from.
   * @param metadata - Optional metadata to help the injection
   */
  export const getter = function injectGetter(
    bindingSelector: BindingSelector<unknown>,
    metadata?: InjectionMetadata,
  ) {
    metadata = Object.assign({decorator: '@inject.getter'}, metadata);
    return inject(
      bindingSelector,
      metadata,
      isBindingAddress(bindingSelector)
        ? resolveAsGetter
        : resolveAsGetterByFilter,
    );
  };

  /**
   * Inject a function for setting (binding) the given key to a given
   * value. (Only static/constant values are supported, it's not possible
   * to bind a key to a class or a provider.)
   *
   * This is useful e.g. when implementing Actions that are contributing
   * new Elements.
   *
   * See also `Setter<T>`.
   *
   * @param bindingKey - The key of the value we want to set.
   * @param metadata - Optional metadata to help the injection
   */
  export const setter = function injectSetter(
    bindingKey: BindingAddress,
    metadata?: InjectBindingMetadata,
  ) {
    metadata = Object.assign({decorator: '@inject.setter'}, metadata);
    return inject(bindingKey, metadata, resolveAsSetter);
  };

  /**
   * Inject the binding object for the given key. This is useful if a binding
   * needs to be set up beyond just a constant value allowed by
   * `@inject.setter`. The injected binding is found or created based on the
   * `metadata.bindingCreation` option. See `BindingCreationPolicy` for more
   * details.
   *
   * @example
   *
   * ```ts
   * class MyAuthAction {
   *   @inject.binding('current-user', {
   *     bindingCreation: BindingCreationPolicy.ALWAYS_CREATE,
   *   })
   *   private userBinding: Binding<UserProfile>;
   *
   *   async authenticate() {
   *     this.userBinding.toDynamicValue(() => {...});
   *   }
   * }
   * ```
   *
   * @param bindingKey - Binding key
   * @param metadata - Metadata for the injection
   */
  export const binding = function injectBinding(
    bindingKey?: string | BindingKey<unknown>,
    metadata?: InjectBindingMetadata,
  ) {
    metadata = Object.assign({decorator: '@inject.binding'}, metadata);
    return inject(bindingKey ?? '', metadata, resolveAsBinding);
  };

  /**
   * Inject an array of values by a tag pattern string or regexp
   *
   * @example
   * ```ts
   * class AuthenticationManager {
   *   constructor(
   *     @inject.tag('authentication.strategy') public strategies: Strategy[],
   *   ) {}
   * }
   * ```
   * @param bindingTag - Tag name, regex or object
   * @param metadata - Optional metadata to help the injection
   */
  export const tag = function injectByTag(
    bindingTag: BindingTag | RegExp,
    metadata?: InjectionMetadata,
  ) {
    metadata = Object.assign(
      {decorator: '@inject.tag', tag: bindingTag},
      metadata,
    );
    return inject(filterByTag(bindingTag), metadata);
  };

  /**
   * Inject matching bound values by the filter function
   *
   * @example
   * ```ts
   * class MyControllerWithView {
   *   @inject.view(filterByTag('foo'))
   *   view: ContextView<string[]>;
   * }
   * ```
   * @param bindingFilter - A binding filter function
   * @param metadata
   */
  export const view = function injectContextView(
    bindingFilter: BindingFilter,
    metadata?: InjectionMetadata,
  ) {
    metadata = Object.assign({decorator: '@inject.view'}, metadata);
    return inject(bindingFilter, metadata, resolveAsContextView);
  };

  /**
   * Inject the context object.
   *
   * @example
   * ```ts
   * class MyProvider {
   *  constructor(@inject.context() private ctx: Context) {}
   * }
   * ```
   */
  export const context = function injectContext() {
    return inject('', {decorator: '@inject.context'}, (ctx: Context) => ctx);
  };
}

/**
 * Assert the target type inspected from TypeScript for injection to be the
 * expected type. If the types don't match, an error is thrown.
 * @param injection - Injection information
 * @param expectedType - Expected type
 * @param expectedTypeName - Name of the expected type to be used in the error
 * @returns The name of the target
 */
export function assertTargetType(
  injection: Readonly<Injection>,
  expectedType: Function,
  expectedTypeName?: string,
) {
  const targetName = ResolutionSession.describeInjection(injection).targetName;
  const targetType = inspectTargetType(injection);
  if (targetType && targetType !== expectedType) {
    expectedTypeName = expectedTypeName ?? expectedType.name;
    throw new Error(
      `The type of ${targetName} (${targetType.name}) is not ${expectedTypeName}`,
    );
  }
  return targetName;
}

/**
 * Resolver for `@inject.getter`
 * @param ctx
 * @param injection
 * @param session
 */
function resolveAsGetter(
  ctx: Context,
  injection: Readonly<Injection>,
  session: ResolutionSession,
) {
  assertTargetType(injection, Function, 'Getter function');
  const bindingSelector = injection.bindingSelector as BindingAddress;
  const options: ResolutionOptions = {
    // https://github.com/loopbackio/loopback-next/issues/9041
    // We should start with a new session for `getter` resolution to avoid
    // possible circular dependencies
    session: undefined,
    ...injection.metadata,
  };
  return function getter() {
    return ctx.get(bindingSelector, options);
  };
}

/**
 * Resolver for `@inject.setter`
 * @param ctx
 * @param injection
 */
function resolveAsSetter(ctx: Context, injection: Injection) {
  const targetName = assertTargetType(injection, Function, 'Setter function');
  const bindingSelector = injection.bindingSelector;
  if (!isBindingAddress(bindingSelector)) {
    throw new Error(
      `@inject.setter (${targetName}) does not allow BindingFilter.`,
    );
  }
  if (bindingSelector === '') {
    throw new Error('Binding key is not set for @inject.setter');
  }
  // No resolution session should be propagated into the setter
  return function setter(value: unknown) {
    const binding = findOrCreateBindingForInjection(ctx, injection);
    binding!.to(value);
  };
}

function resolveAsBinding(
  ctx: Context,
  injection: Injection,
  session: ResolutionSession,
) {
  const targetName = assertTargetType(injection, Binding);
  const bindingSelector = injection.bindingSelector;
  if (!isBindingAddress(bindingSelector)) {
    throw new Error(
      `@inject.binding (${targetName}) does not allow BindingFilter.`,
    );
  }
  return findOrCreateBindingForInjection(ctx, injection, session);
}

function findOrCreateBindingForInjection(
  ctx: Context,
  injection: Injection<unknown>,
  session?: ResolutionSession,
) {
  if (injection.bindingSelector === '') return session?.currentBinding;
  const bindingCreation =
    injection.metadata &&
    (injection.metadata as InjectBindingMetadata).bindingCreation;
  const binding: Binding<unknown> = ctx.findOrCreateBinding(
    injection.bindingSelector as BindingAddress,
    bindingCreation,
  );
  return binding;
}

/**
 * Check if constructor injection should be applied to the base class
 * of the given target class
 *
 * @param targetClass - Target class
 */
function shouldSkipBaseConstructorInjection(targetClass: Object) {
  // FXIME(rfeng): We use the class definition to check certain patterns
  const classDef = targetClass.toString();
  return (
    /*
     * See https://github.com/loopbackio/loopback-next/issues/2946
     * A class decorator can return a new constructor that mixes in
     * additional properties/methods.
     *
     * @example
     * ```ts
     * class extends baseConstructor {
     *   // The constructor calls `super(...arguments)`
     *   constructor() {
     *     super(...arguments);
     *   }
     *   classProperty = 'a classProperty';
     *   classFunction() {
     *     return 'a classFunction';
     *   }
     * };
     * ```
     *
     * We check the following pattern:
     * ```ts
     * constructor() {
     *   super(...arguments);
     * }
     * ```
     */
    !classDef.match(
      /\s+constructor\s*\(\s*\)\s*\{\s*super\(\.\.\.arguments\)/,
    ) &&
    /*
     * See https://github.com/loopbackio/loopback-next/issues/1565
     *
     * @example
     * ```ts
     * class BaseClass {
     *   constructor(@inject('foo') protected foo: string) {}
     *   // ...
     * }
     *
     * class SubClass extends BaseClass {
     *   // No explicit constructor is present
     *
     *   @inject('bar')
     *   private bar: number;
     *   // ...
     * };
     *
     */
    classDef.match(/\s+constructor\s*\([^\)]*\)\s+\{/m)
  );
}

/**
 * Return an array of injection objects for parameters
 * @param target - The target class for constructor or static methods,
 * or the prototype for instance methods
 * @param method - Method name, undefined for constructor
 */
export function describeInjectedArguments(
  target: Object,
  method?: string,
): Readonly<Injection>[] {
  method = method ?? '';

  // Try to read from cache
  const cache =
    MetadataInspector.getAllMethodMetadata<Readonly<Injection>[]>(
      INJECT_METHODS_KEY,
      target,
      {
        ownMetadataOnly: true,
      },
    ) ?? {};
  let meta: Readonly<Injection>[] = cache[method];
  if (meta) return meta;

  // Build the description
  const options: InspectionOptions = {};
  if (method === '') {
    if (shouldSkipBaseConstructorInjection(target)) {
      options.ownMetadataOnly = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(target, method)) {
    // The method exists in the target, no injections on the super method
    // should be honored
    options.ownMetadataOnly = true;
  }
  meta =
    MetadataInspector.getAllParameterMetadata<Readonly<Injection>>(
      INJECT_PARAMETERS_KEY,
      target,
      method,
      options,
    ) ?? [];

  // Static-form injection (`static inject = {params}` / `static
  // injectMethods`): the decorator-free path. Takes precedence; mixing the
  // two styles on one scope is an error.
  const staticParams = staticInjectParams(target, method);
  if (staticParams) {
    if (meta.some(m => m != null)) {
      throw new Error(
        `Mixed injection styles on ${describeScope(target, method)}: ` +
          `both 'static inject' and @inject decorators are present. Use one.`,
      );
    }
    // Sparse like the decorator path: `undefined` marks non-injected slots.
    meta = staticParams.map((entry, index) =>
      normalizeInjectSpec(entry, target, method || undefined, index),
    ) as Readonly<Injection>[];
  }

  // Cache the result
  cache[method] = meta;
  MetadataInspector.defineMetadata<MetadataMap<Readonly<Injection>[]>>(
    INJECT_METHODS_KEY,
    cache,
    target,
  );
  return meta;
}

/**
 * Inspect the target type for the injection to find out the corresponding
 * JavaScript type
 * @param injection - Injection information
 */
export function inspectTargetType(injection: Readonly<Injection>) {
  if (typeof injection.methodDescriptorOrParameterIndex === 'number') {
    const designType = MetadataInspector.getDesignTypeForMethod(
      injection.target,
      injection.member!,
    );
    return designType?.parameterTypes?.[
      injection.methodDescriptorOrParameterIndex as number
    ];
  }
  return MetadataInspector.getDesignTypeForProperty(
    injection.target,
    injection.member!,
  );
}

/**
 * Resolve an array of bound values matching the filter function for `@inject`.
 * @param ctx - Context object
 * @param injection - Injection information
 * @param session - Resolution session
 */
function resolveValuesByFilter(
  ctx: Context,
  injection: Readonly<Injection>,
  session: ResolutionSession,
) {
  assertTargetType(injection, Array);
  const bindingFilter = injection.bindingSelector as BindingFilter;
  const view = new ContextView(
    ctx,
    bindingFilter,
    injection.metadata.bindingComparator,
  );
  return view.resolve(session);
}

/**
 * Resolve to a getter function that returns an array of bound values matching
 * the filter function for `@inject.getter`.
 *
 * @param ctx - Context object
 * @param injection - Injection information
 * @param session - Resolution session
 */
function resolveAsGetterByFilter(
  ctx: Context,
  injection: Readonly<Injection>,
  session: ResolutionSession,
) {
  assertTargetType(injection, Function, 'Getter function');
  const bindingFilter = injection.bindingSelector as BindingFilter;
  return createViewGetter(
    ctx,
    bindingFilter,
    injection.metadata.bindingComparator,
    session,
  );
}

/**
 * Resolve to an instance of `ContextView` by the binding filter function
 * for `@inject.view`
 * @param ctx - Context object
 * @param injection - Injection information
 */
function resolveAsContextView(ctx: Context, injection: Readonly<Injection>) {
  assertTargetType(injection, ContextView);

  const bindingFilter = injection.bindingSelector as BindingFilter;
  const view = new ContextView(
    ctx,
    bindingFilter,
    injection.metadata.bindingComparator,
  );
  view.open();
  return view;
}

/**
 * Return a map of injection objects for properties
 * @param target - The target class for static properties or
 * prototype for instance properties.
 */
export function describeInjectedProperties(
  target: Object,
): MetadataMap<Readonly<Injection>> {
  const metadata =
    MetadataInspector.getAllPropertyMetadata<Readonly<Injection>>(
      INJECT_PROPERTIES_KEY,
      target,
    ) ?? {};

  // Static-form property injection (`static inject = {properties}`).
  const statics = staticInjectOf(target);
  const props = statics?.properties;
  if (props && Object.keys(props).length > 0) {
    if (Object.keys(metadata).length > 0) {
      throw new Error(
        `Mixed injection styles on ${describeScope(target, '')}: ` +
          `both 'static inject' properties and @inject decorators are ` +
          `present. Use one.`,
      );
    }
    const out: MetadataMap<Readonly<Injection>> = {};
    for (const [member, entry] of Object.entries(props)) {
      out[member] = normalizeInjectSpec(entry, target, member, undefined);
    }
    return out;
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Injection without parameter decorators — the `static inject` form.
//
// TC39 Stage 3 decorators have no parameter decorators, so `@inject` on
// constructor/method parameters cannot survive a migration to standard
// decorators. The static form expresses the same injections as plain data:
//
// ```ts
// class OrderService {
//   static inject = {
//     params: [DB_KEY, injectSpec.tag('payment.rails')],
//     properties: {clock: CLOCK_KEY},
//   } satisfies InjectStatics;
//   constructor(private db: Db, private rails: PaymentRail[]) {}
//   clock!: Clock;
// }
// ```
//
// Method-parameter injection (slots 1+ next to a validated input bundle)
// uses `static injectMethods = {methodName: [undefined, USER_KEY]}`.
// ---------------------------------------------------------------------------

/**
 * A plain injection descriptor — the data the `@inject` decorator family
 * records, without the decorator. Produce these with the `injectSpec.*`
 * helpers, or pass a bare binding key as shorthand for `injectSpec.key(...)`.
 */
export interface InjectSpec {
  bindingSelector: BindingSelector;
  metadata?: InjectionMetadata;
  resolve?: ResolverFunction;
}

/**
 * One slot of a `params` array: a binding key (shorthand), a full spec, or
 * `undefined` for non-injected slots (e.g. a REST route's slot-0 input
 * bundle).
 */
export type InjectSpecEntry =
  | BindingAddress
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | BindingKey<any>
  | InjectSpec
  | undefined;

/** Shape of a class's `static inject` property. */
export interface InjectStatics {
  /** Constructor-parameter injections, by position. */
  params?: ReadonlyArray<InjectSpecEntry>;
  /** Property injections, by property name. */
  properties?: Record<string, Exclude<InjectSpecEntry, undefined>>;
}

/** Shape of a class's `static injectMethods` property. */
export type InjectMethodStatics = Record<
  string,
  ReadonlyArray<InjectSpecEntry>
>;

/**
 * Descriptor-producing counterparts of the `@inject.*` decorator helpers.
 * Unlike the decorators these return plain values and write no metadata —
 * usable inside `static inject` / `static injectMethods`.
 */
export namespace injectSpec {
  /** Equivalent of `@inject(selector)`. */
  export function key(
    bindingSelector: BindingSelector,
    metadata?: InjectionMetadata,
  ): InjectSpec {
    return {
      bindingSelector,
      metadata: {decorator: 'injectSpec.key', ...metadata},
    };
  }

  /** Equivalent of `@inject.tag(tag)` — an array of values by tag. */
  export function tag(
    bindingTag: BindingTag | RegExp,
    metadata?: InjectionMetadata,
  ): InjectSpec {
    return {
      bindingSelector: filterByTag(bindingTag),
      metadata: {decorator: 'injectSpec.tag', tag: bindingTag, ...metadata},
    };
  }

  /** Equivalent of `@inject.getter(selector)`. */
  export function getter(
    bindingSelector: BindingSelector,
    metadata?: InjectionMetadata,
  ): InjectSpec {
    return {
      bindingSelector,
      metadata: {decorator: 'injectSpec.getter', ...metadata},
      resolve: isBindingAddress(bindingSelector)
        ? resolveAsGetter
        : resolveAsGetterByFilter,
    };
  }

  /** Equivalent of `@inject.setter(key)`. */
  export function setter(
    bindingKey: BindingAddress,
    metadata?: InjectBindingMetadata,
  ): InjectSpec {
    return {
      bindingSelector: bindingKey,
      metadata: {decorator: 'injectSpec.setter', ...metadata},
      resolve: resolveAsSetter,
    };
  }

  /** Equivalent of `@inject.binding(key)`. */
  export function binding(
    bindingKey?: BindingAddress,
    metadata?: InjectBindingMetadata,
  ): InjectSpec {
    return {
      bindingSelector: bindingKey ?? '',
      metadata: {decorator: 'injectSpec.binding', ...metadata},
      resolve: resolveAsBinding,
    };
  }

  /** Equivalent of `@inject.context()`. */
  export function context(): InjectSpec {
    return {
      bindingSelector: '',
      metadata: {decorator: 'injectSpec.context'},
      resolve: ctx => ctx,
    };
  }
}

/** Human-readable scope name for error messages. */
function describeScope(target: Object, method: string): string {
  const ctor = classOf(target, method);
  return method === '' ? ctor.name : `${ctor.name}.${method}`;
}

/** The class for a (target, method) pair as describeInjectedArguments sees it. */
function classOf(target: Object, method: string): Function {
  return method === '' && typeof target === 'function'
    ? (target as Function)
    : ((target as {constructor: Function}).constructor ?? Object);
}

/** Does the class's own source declare an explicit constructor? */
function hasOwnExplicitConstructor(ctor: Function): boolean {
  return /\sconstructor\s*\(/.test(ctor.toString());
}

/**
 * Look up the effective `static inject` for the class owning `target`.
 * Own properties always apply. Inherited statics apply only when the class
 * has no explicit own constructor (an implicit constructor has the parent's
 * signature, so the parent's params are correct). A subclass that declares
 * its own constructor must declare its own `static inject` — silently
 * resolving with the parent's arity is the footgun this rule prevents.
 */
function staticInjectOf(target: Object): InjectStatics | undefined {
  const ctor = classOf(target, typeof target === 'function' ? '' : 'x');
  const value = (ctor as {inject?: unknown}).inject;
  if (value == null || typeof value !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(ctor, 'inject')) {
    return value as InjectStatics;
  }
  // Inherited: only valid with an implicit constructor.
  if (hasOwnExplicitConstructor(ctor)) return undefined;
  return value as InjectStatics;
}

/** The static params list for the requested scope, if declared. */
function staticInjectParams(
  target: Object,
  method: string,
): ReadonlyArray<InjectSpecEntry> | undefined {
  if (method === '') {
    if (typeof target !== 'function') return undefined;
    return staticInjectOf(target)?.params;
  }
  const ctor = classOf(target, method);
  const methods = (ctor as {injectMethods?: InjectMethodStatics}).injectMethods;
  if (methods == null) return undefined;
  // Mirror the decorator path's own-method rule: when the method is
  // redefined on this prototype, inherited static specs don't apply.
  if (
    !Object.prototype.hasOwnProperty.call(ctor, 'injectMethods') &&
    Object.prototype.hasOwnProperty.call(target, method)
  ) {
    return undefined;
  }
  return methods[method];
}

/** Convert one static entry into the `Injection` shape resolvers consume. */
function normalizeInjectSpec(
  entry: Exclude<InjectSpecEntry, undefined>,
  target: Object,
  member: string | undefined,
  index: number | undefined,
): Readonly<Injection>;
function normalizeInjectSpec(
  entry: InjectSpecEntry,
  target: Object,
  member: string | undefined,
  index: number | undefined,
): Readonly<Injection> | undefined;
function normalizeInjectSpec(
  entry: InjectSpecEntry,
  target: Object,
  member: string | undefined,
  index: number | undefined,
): Readonly<Injection> | undefined {
  if (entry == null) return undefined;
  const spec: InjectSpec =
    typeof entry === 'object' && 'bindingSelector' in entry
      ? (entry as InjectSpec)
      : {bindingSelector: entry as BindingSelector};
  let resolve = spec.resolve;
  // Same defaulting `inject()` applies: filter selectors resolve to arrays.
  if (typeof spec.bindingSelector === 'function' && !resolve) {
    resolve = resolveValuesByFilter;
  }
  return {
    target,
    member,
    methodDescriptorOrParameterIndex: index,
    bindingSelector: spec.bindingSelector,
    metadata: {decorator: 'static inject', ...spec.metadata},
    resolve,
  };
}

/**
 * Inspect injections for a binding created with `toClass` or `toProvider`
 * @param binding - Binding object
 */
export function inspectInjections(binding: Readonly<Binding<unknown>>) {
  const json: JSONObject = {};
  const ctor = binding.valueConstructor ?? binding.providerConstructor;
  if (ctor == null) return json;
  const constructorInjections = describeInjectedArguments(ctor, '').map(
    inspectInjection,
  );
  if (constructorInjections.length) {
    json.constructorArguments = constructorInjections;
  }
  const propertyInjections = describeInjectedProperties(ctor.prototype);
  const properties: JSONObject = {};
  for (const p in propertyInjections) {
    properties[p] = inspectInjection(propertyInjections[p]);
  }
  if (Object.keys(properties).length) {
    json.properties = properties;
  }
  return json;
}

/**
 * Inspect an injection
 * @param injection - Injection information
 */
function inspectInjection(injection: Readonly<Injection<unknown>>) {
  const injectionInfo = ResolutionSession.describeInjection(injection);
  const descriptor: JSONObject = {};
  if (injectionInfo.targetName) {
    descriptor.targetName = injectionInfo.targetName;
  }
  if (isBindingAddress(injectionInfo.bindingSelector)) {
    // Binding key
    descriptor.bindingKey = injectionInfo.bindingSelector.toString();
  } else if (isBindingTagFilter(injectionInfo.bindingSelector)) {
    // Binding tag filter
    descriptor.bindingTagPattern = JSON.parse(
      JSON.stringify(injectionInfo.bindingSelector.bindingTagPattern),
    );
  } else {
    // Binding filter function
    descriptor.bindingFilter =
      injectionInfo.bindingSelector?.name ?? '<function>';
  }
  // Inspect metadata
  if (injectionInfo.metadata) {
    if (
      injectionInfo.metadata.decorator &&
      injectionInfo.metadata.decorator !== '@inject'
    ) {
      descriptor.decorator = injectionInfo.metadata.decorator;
    }
    if (injectionInfo.metadata.optional) {
      descriptor.optional = injectionInfo.metadata.optional;
    }
  }
  return descriptor;
}

/**
 * Check if the given class has `@inject` or other decorations that map to
 * `@inject`.
 *
 * @param cls - Class with possible `@inject` decorations
 */
export function hasInjections(cls: Constructor<unknown>): boolean {
  return (
    MetadataInspector.getClassMetadata(INJECT_PARAMETERS_KEY, cls) != null ||
    Reflector.getMetadata(INJECT_PARAMETERS_KEY.toString(), cls.prototype) !=
      null ||
    MetadataInspector.getAllPropertyMetadata(
      INJECT_PROPERTIES_KEY,
      cls.prototype,
    ) != null
  );
}
