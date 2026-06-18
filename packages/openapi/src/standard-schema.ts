// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The Standard Schema V1 interface (https://standardschema.dev), vendored as
 * the spec recommends — it is designed to be copied rather than depended on.
 * Any library exposing `~standard` (Zod, Valibot, ArkType, …) satisfies it.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<S extends StandardSchemaV1> = NonNullable<
    S['~standard']['types']
  >['input'];

  export type InferOutput<S extends StandardSchemaV1> = NonNullable<
    S['~standard']['types']
  >['output'];
}

/** Structural check for the `~standard` marker. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    '~standard' in value &&
    (value as StandardSchemaV1)['~standard']?.version === 1
  );
}
