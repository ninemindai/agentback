// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describeInjectedArguments} from '@agentback/context';
import {MethodDecoratorFactory} from '@agentback/metadata';
import type {InferSchema, SchemaLike} from '@agentback/openapi';
import {MCPKeys, ToolMetadata, ToolUiMeta} from '../keys.js';

export interface ToolOptions<S extends SchemaLike> {
  /**
   * Schema describing the tool's input arguments: a Zod object or any
   * Standard Schema V1 (`~standard`) vendor. Non-Zod schemas must be able to
   * emit JSON Schema (native `toJsonSchema()` capability or a converter
   * registered via `registerJSONSchemaConverter`) — enforced at registration
   * time (`app.start()` / `buildServer`).
   */
  input: S;
  description?: string;
  title?: string;
  /**
   * OAuth scope required to see and call this tool over an authenticated
   * transport (see `@agentback/mcp-http`). Omit for an always-available
   * tool.
   */
  scope?: string;
  /**
   * Dangerous tool: the first call is refused with a `confirmation_required`
   * error carrying a single-use token bound to the exact input; retrying the
   * identical call with the token in the optional `confirmationToken` input
   * property executes it. The property is added to the advertised
   * inputSchema automatically. `{ttlMs}` overrides the 5-minute lifetime.
   */
  confirm?: boolean | {ttlMs?: number};
  /**
   * MCP Apps (SEP-1865) UI link: render this tool's results as a widget. The
   * `resourceUri` names a `@resource('ui://…', {mimeType: MCP_APP_MIME_TYPE})`
   * that returns the widget HTML; pair it with an `output:` schema so the
   * widget has `structuredContent` to bind. Emitted as `_meta.ui` on the
   * tool's `tools/list` entry.
   */
  ui?: ToolUiMeta;
}

export interface ToolOptionsWithOutput<
  S extends SchemaLike,
  O extends SchemaLike,
> extends ToolOptions<S> {
  /**
   * Schema describing the tool's structured output (same kinds as `input`).
   * When set, the server validates the method's return value at invocation
   * time and emits the schema in `tools/list` + the inspector manifest.
   */
  output: O;
}

export interface ToolOptionsNoInput {
  description?: string;
  title?: string;
  /** OAuth scope required to see and call this tool (see `ToolOptions.scope`). */
  scope?: string;
  /** Dangerous tool: require a confirmation round-trip (see `ToolOptions.confirm`). */
  confirm?: boolean | {ttlMs?: number};
  /** MCP Apps (SEP-1865) UI link for this tool's results (see `ToolOptions.ui`). */
  ui?: ToolUiMeta;
}

/**
 * Declare a method as an MCP tool.
 *
 * - With `input`: the schema becomes the tool's `inputSchema` and the
 *   method's slot 0 must be typed `z.infer<typeof input>` (or the Standard
 *   Schema equivalent). `@inject(...)` parameters may appear at slot 1+.
 * - With `output`: the return type is also constrained at compile time
 *   and validated at runtime.
 * - Without `input`: the tool takes no validated input and the method's
 *   signature is fully `@inject`-driven.
 *
 * Streaming tools: a method that returns an async iterable (an async
 * generator, e.g. one also exposed as a `@get(..., {streamOf: X})` SSE route)
 * is drained when invoked over MCP — each yielded item is relayed as a
 * progress notification and the collected items become the tool result. For
 * such a tool, `output:` describes the COLLECTED shape, typically
 * `z.array(ItemSchema)`, and output validation applies to that array.
 *
 * @example
 *   const ForecastInput = z.object({city: z.string()});
 *   const ForecastOutput = z.object({forecast: z.string()});
 *
 *   @tool('get_forecast', {input: ForecastInput, output: ForecastOutput})
 *   async getForecast(input: z.infer<typeof ForecastInput>) {
 *     return {forecast: 'sunny'};
 *   }
 *
 *   @tool('whoami')
 *   async whoami(@inject('services.identity') id: IdentityService) {
 *     return id.current();
 *   }
 */

// Overload 1: input + output → constrain slot 0 and the return type.
export function tool<S extends SchemaLike, O extends SchemaLike>(
  name: string,
  options: ToolOptionsWithOutput<S, O>,
): <R extends InferSchema<O> | Promise<InferSchema<O>>>(
  target: object,
  methodName: string | symbol,
  desc: TypedPropertyDescriptor<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (input: InferSchema<S>, ...rest: any[]) => R
  >,
) => void;

// Overload 2: input only → constrain slot 0.
export function tool<S extends SchemaLike>(
  name: string,
  options: ToolOptions<S>,
): (
  target: object,
  methodName: string | symbol,
  desc: TypedPropertyDescriptor<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (input: InferSchema<S>, ...rest: any[]) => any
  >,
) => void;

// Overload 3: no input → all slots are free (typically all `@inject`).
export function tool(
  name: string,
  options?: ToolOptionsNoInput,
): (
  target: object,
  methodName: string | symbol,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: TypedPropertyDescriptor<(...args: any[]) => any>,
) => void;

export function tool(
  name: string,
  options: {
    input?: SchemaLike;
    output?: SchemaLike;
    description?: string;
    title?: string;
    scope?: string;
    confirm?: boolean | {ttlMs?: number};
    ui?: ToolUiMeta;
  } = {},
): MethodDecorator {
  return function toolDecorator(
    target: object,
    methodName: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    // Slot-0 guard: when input is declared, slot 0 is the validated input —
    // refuse @inject at slot 0 so the error surfaces at decoration time.
    if (options.input != null) {
      const injected = describeInjectedArguments(target, methodName as string);
      if (injected[0] != null) {
        const className =
          (target as {constructor?: {name: string}}).constructor?.name ??
          'anonymous';
        throw new Error(
          `@tool('${name}') on ${className}.${String(methodName)}: slot 0 is ` +
            `reserved for the validated input bundle when input: is set. ` +
            `Move @inject(...) to slot 1+.`,
        );
      }
    }

    const meta: ToolMetadata = {
      name,
      description: options.description,
      title: options.title,
      input: options.input,
      output: options.output,
      scope: options.scope,
      confirm: options.confirm,
      ui: options.ui,
      methodName,
    };
    MethodDecoratorFactory.createDecorator<ToolMetadata>(MCPKeys.TOOL, meta, {
      decoratorName: '@tool',
    })(target, methodName, descriptor);
  };
}
