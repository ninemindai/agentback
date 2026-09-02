// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The structural subset of the AI SDK's language-model surface this package
 * needs. Declared here rather than imported so `ai` stays an OPTIONAL peer
 * dependency and its provider-spec version never enters AgentBack's public DI
 * surface — the same `ChatLike` / `AgentPort` discipline `@agentback/chat` and
 * `@agentback/agents` follow.
 *
 * A real `LanguageModelV3`/`V4` satisfies these structurally, so
 * `wrapLanguageModel({model, middleware})` accepts what we build.
 */

/** Token accounting as the provider reported it. Every field may be absent. */
export interface ModelUsage {
  inputTokens?: {total?: number; cacheRead?: number; cacheWrite?: number};
  outputTokens?: {total?: number};
}

/** The call options a middleware observes. Only the fields we act on. */
export interface ModelCallParams {
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

/** A generate result, narrowed to what the accounting policies read. */
export interface ModelGenerateResult {
  usage?: ModelUsage;
  [key: string]: unknown;
}

/** A stream result. The stream body is opaque to this package. */
export interface ModelStreamResult {
  [key: string]: unknown;
}

/**
 * The structural language model — enough to name it in logs and to call it
 * directly (which only the fallback policy does).
 *
 * The signatures are deliberately loose: `never` parameters are bivariant for
 * method syntax, so a real `LanguageModelV3`/`V4` with its own call-options
 * type satisfies this, and `unknown` returns accept whatever the provider
 * spec's result type is this month. Tightening either end would pin this
 * package to one provider-spec version — exactly what declaring our own
 * structural port is meant to avoid.
 */
export interface LanguageModelLike {
  readonly modelId?: string;
  readonly provider?: string;
  doGenerate(options: never): unknown;
  doStream?(options: never): unknown;
}

/** Arguments the SDK hands a middleware hook. */
export interface ModelMiddlewareArgs {
  doGenerate: () => PromiseLike<ModelGenerateResult>;
  doStream: () => PromiseLike<ModelStreamResult>;
  params: ModelCallParams;
  model: LanguageModelLike;
}

/**
 * A language-model middleware. Structurally assignable to the AI SDK's
 * `LanguageModelMiddleware`, whose `specificationVersion` is optional.
 */
export interface ModelMiddleware {
  transformParams?: (options: {
    type: 'generate' | 'stream';
    params: ModelCallParams;
    model: LanguageModelLike;
  }) => PromiseLike<ModelCallParams>;
  wrapGenerate?: (
    options: ModelMiddlewareArgs,
  ) => PromiseLike<ModelGenerateResult>;
  wrapStream?: (options: ModelMiddlewareArgs) => PromiseLike<ModelStreamResult>;
}

/** Total billable tokens in a result — the unit token accounting is kept in. */
export function totalTokens(usage: ModelUsage | undefined): number {
  return (usage?.inputTokens?.total ?? 0) + (usage?.outputTokens?.total ?? 0);
}

/** A short, stable label for a model, for logs and usage-event operations. */
export function modelLabel(model: LanguageModelLike): string {
  const id = model.modelId ?? 'unknown';
  return model.provider ? `${model.provider}:${id}` : id;
}
