// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {AuthInfo} from '@modelcontextprotocol/server';
import {composeTeardown} from '@agentback/common';
import {inject} from '@agentback/context';
import {unbindOwned, type Application, type Installed} from '@agentback/core';
import {
  addTool,
  contributeCapabilities,
  isSynthesizedPrincipal,
  MCPBindings,
  mcpServer,
  tool,
  type JsonValue,
  type MCPServer,
} from '@agentback/mcp';
import {AgentError} from '@agentback/openapi';
import {
  securityId,
  SecurityBindings,
  type UserProfile,
} from '@agentback/security';
import {z} from 'zod';
import {accepts, warn, nonBlank, OPENAI_SETTINGS_CAPABILITY} from './shared.js';

// Structured settings (proposal §6). The API is host-neutral — a schema, a
// per-principal store, a read and an update tool — and `advertise` projects
// it onto a host's capability (today only OpenAI's `openai/settings`).

/** Persists one principal's settings. Only explicitly set fields are stored. */
export interface SettingsStore<V extends object = Record<string, unknown>> {
  /** The fields stored for `key`, or `undefined` when none are. */
  get(key: string): Promise<Partial<V> | undefined>;
  /**
   * Merge `patch` into the fields stored for `key` — atomically, for a
   * store shared across instances — and return every stored field.
   */
  update(key: string, patch: Partial<V>): Promise<Partial<V>>;
}

/**
 * A process-local {@link SettingsStore}: settings vanish on restart and are
 * not shared across instances. For tests and single-process development;
 * `installSettings` warns when it is used.
 */
export class InMemorySettingsStore<
  V extends object = Record<string, unknown>,
> implements SettingsStore<V> {
  private readonly data = new Map<string, Partial<V>>();
  async get(key: string): Promise<Partial<V> | undefined> {
    const v = this.data.get(key);
    return v ? {...v} : undefined;
  }
  async update(key: string, patch: Partial<V>): Promise<Partial<V>> {
    const next = {...(this.data.get(key) ?? {}), ...patch};
    this.data.set(key, next);
    return {...next};
  }
}

/** A settings layout group: properties and tool buttons, in order. */
export interface SettingsGroup<K extends string = string> {
  kind: 'group';
  title: string;
  items: (
    | {kind: 'property'; property: K}
    | {
        kind: 'tool';
        /** A tool on this server that accepts `{}`; checked at `start()`. */
        tool: string;
        title: string;
        description?: string;
      }
  )[];
}

// Zod 4's object type; kept loose so any z.object(...) is accepted.
type AnyZodObject = z.ZodObject<z.ZodRawShape>;

export interface InstallSettingsOptions<S extends AnyZodObject> {
  /**
   * The settings: a `z.object` of primitive fields (boolean, string,
   * string enum, number, integer), each with a `.default()` and a
   * `.meta({title})`. The schema is the single source — defaults, titles and
   * validation all come from it.
   */
  schema: S;
  /** Required. {@link InMemorySettingsStore} only for tests and dev. */
  store: SettingsStore<z.output<S>>;
  /** Groups shown in order; fields left out appear under "Other settings". */
  layout?: SettingsGroup<keyof z.output<S> & string>[];
  /** Tool names; defaults `settings_read` / `settings_update`. */
  names?: {read?: string; update?: string};
  /**
   * Hosts to advertise to. Default `['openai']`, which contributes
   * `openai/settings` under both `extensions` (2026) and `experimental`
   * (2025-era ChatGPT). `[]` registers the tools only.
   */
  advertise?: 'openai'[];
  /**
   * Whose settings a call reads and writes. The default uses only a
   * **verified** user — one an authentication strategy supplied — and never a
   * principal synthesized from a token's `clientId`, which names the host
   * application shared by all of its users. Return `undefined` for "no
   * identity": update refuses, read returns defaults.
   */
  principalKey?: (
    user: UserProfile | undefined,
    auth: AuthInfo | undefined,
  ) => string | undefined;
  /**
   * One settings bucket for everyone — an explicit opt-in for single-user
   * deployments (a local stdio server). Cannot be combined with
   * `principalKey`.
   */
  shared?: boolean;
}

const FIELD_KEYS = new Set([
  'type',
  'title',
  'description',
  'enum',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'multipleOf',
]);
const FIELD_TYPES = new Set(['boolean', 'string', 'number', 'integer']);

/** Error code a settings update gets when the caller has no identity. */
export const SETTINGS_IDENTITY_REQUIRED = 'settings_identity_required';

function defaultPrincipalKey(
  user: UserProfile | undefined,
): string | undefined {
  if (!user || isSynthesizedPrincipal(user)) return undefined;
  const id = user[securityId];
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Emit the settings schema for the read result: OpenAI's `SettingSchema`
 * allows no `default` and only primitive fields, so both are enforced here,
 * at install, rather than discovered by the host.
 */
function settingsJsonSchema(schema: AnyZodObject): {
  type: 'object';
  properties: Record<string, Record<string, JsonValue>>;
} {
  const shape = schema.shape;
  const emitted = z.toJSONSchema(schema, {io: 'input'}) as {
    properties?: Record<string, Record<string, JsonValue>>;
  };
  const properties: Record<string, Record<string, JsonValue>> = {};
  for (const key of Object.keys(shape)) {
    if (!(shape[key] instanceof z.ZodDefault)) {
      throw new Error(
        `settings field '${key}' needs a .default() — the default is the ` +
          `value every principal starts with`,
      );
    }
    const prop = {...(emitted.properties?.[key] ?? {})};
    delete prop.default;
    if (!FIELD_TYPES.has(prop.type as string)) {
      throw new Error(
        `settings field '${key}' must be a boolean, string, string enum, ` +
          `number or integer`,
      );
    }
    for (const k of Object.keys(prop)) {
      if (!FIELD_KEYS.has(k)) {
        throw new Error(
          `settings field '${key}' uses '${k}', which a settings schema cannot express`,
        );
      }
    }
    if (prop.enum !== undefined && prop.type !== 'string') {
      throw new Error(
        `settings field '${key}': only string fields may be enums`,
      );
    }
    if (typeof prop.title !== 'string' || !/\S/.test(prop.title)) {
      throw new Error(
        `settings field '${key}' needs a title: .meta({title: '…'})`,
      );
    }
    properties[key] = prop;
  }
  return {type: 'object', properties};
}

/**
 * Structured settings: a read tool and an update tool over a Zod schema and
 * a per-principal store, advertised to ChatGPT as `openai/settings`.
 *
 * - The read tool is read-only, accepts `{}` and declares its output schema
 *   (both required by OpenAI's spec). It returns the schema (defaults
 *   stripped), every effective value, and the layout.
 * - The update tool takes `{set}` — only the fields that changed, at least
 *   one — validated against the schema, and returns every effective value.
 * - Both run through the normal pipeline (`@authorize`, metering, output
 *   validation). Tool names clashing with an existing tool fail `start()`.
 *
 * `uninstall()` retracts both tools and the capability.
 *
 * @example
 *   const Settings = z.object({
 *     units: z.enum(['mm', 'in']).default('mm').meta({title: 'Measurement units'}),
 *     showGrid: z.boolean().default(false).meta({title: 'Show grid'}),
 *   });
 *   await installSettings(app, {schema: Settings, store: new RedisSettingsStore(redis)});
 *
 * @experimental Tracks OpenAI's MCP extensions spec (0.1.x).
 */
export async function installSettings<S extends AnyZodObject>(
  app: Application,
  options: InstallSettingsOptions<S>,
): Promise<Installed> {
  const {schema, store} = options;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error('installSettings: schema must be a z.object(...)');
  }
  if (!store) throw new Error('installSettings: a store is required');
  if (options.shared && options.principalKey) {
    throw new Error('installSettings: shared and principalKey are exclusive');
  }
  if (store instanceof InMemorySettingsStore) {
    warn(
      'installSettings: InMemorySettingsStore keeps settings in this process ' +
        'only — they are lost on restart and not shared across instances',
    );
  }
  const readName = nonBlank(
    options.names?.read ?? 'settings_read',
    'names.read',
  );
  const updateName = nonBlank(
    options.names?.update ?? 'settings_update',
    'names.update',
  );
  if (readName === updateName) {
    throw new Error('installSettings: read and update need different names');
  }

  const jsonSchema = settingsJsonSchema(schema);
  const keys = Object.keys(jsonSchema.properties);
  const layout = (options.layout ?? []).map(g => structuredClone(g));
  const seen = new Set<string>();
  for (const group of layout) {
    if (group.kind !== 'group')
      throw new Error("layout items are {kind: 'group'}");
    nonBlank(group.title, 'layout group title');
    for (const item of group.items) {
      if (item.kind === 'property') {
        if (!keys.includes(item.property) || seen.has(item.property)) {
          throw new Error(
            `layout: unknown or duplicate settings field '${item.property}'`,
          );
        }
        seen.add(item.property);
      } else if (item.kind === 'tool') {
        nonBlank(item.tool, 'layout tool');
        nonBlank(item.title, 'layout tool title');
      } else {
        throw new Error(
          "layout items are {kind: 'property'} or {kind: 'tool'}",
        );
      }
    }
  }

  const defaults = schema.parse({}) as Record<string, unknown>;
  const fields = Object.fromEntries(
    keys.map(k => [k, (schema.shape[k] as z.ZodDefault).unwrap() as z.ZodType]),
  );
  const Values = z.object(fields).strict();
  const SetIn = z
    .object(Object.fromEntries(keys.map(k => [k, fields[k].optional()])))
    .strict()
    .refine(s => Object.keys(s).length > 0, 'Set at least one setting.')
    .meta({minProperties: 1});
  const ReadOut = z.object({
    schema: z.object({
      type: z.literal('object'),
      properties: z.record(z.string(), z.unknown()),
    }),
    values: Values,
    layout: z.array(z.unknown()).optional(),
  });
  const UpdateIn = z.object({set: SetIn}).strict();
  const UpdateOut = z.object({values: Values});

  const keyFor = (user?: UserProfile, auth?: AuthInfo) =>
    options.shared
      ? 'shared'
      : options.principalKey
        ? options.principalKey(user, auth)
        : defaultPrincipalKey(user);
  const effective = (stored: Record<string, unknown> | undefined) =>
    Values.parse({...defaults, ...(stored ?? {})});

  @mcpServer()
  class SettingsTools {
    @tool(readName, {
      description: 'Read the settings schema, current values and layout.',
      input: z.object({}).strict(),
      output: ReadOut,
      annotations: {readOnlyHint: true},
    })
    async read(
      _input: Record<string, never>,
      @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
      @inject(MCPBindings.REQUEST_AUTH, {optional: true}) auth?: AuthInfo,
    ) {
      const key = keyFor(user, auth);
      const stored = key ? await store.get(key) : undefined;
      return {
        schema: jsonSchema,
        values: effective(stored as Record<string, unknown> | undefined),
        ...(layout.length ? {layout} : {}),
      };
    }

    @tool(updateName, {
      description: 'Update the settings that changed; returns every value.',
      input: UpdateIn,
      output: UpdateOut,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    })
    async update(
      input: z.infer<typeof UpdateIn>,
      @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
      @inject(MCPBindings.REQUEST_AUTH, {optional: true}) auth?: AuthInfo,
    ) {
      const key = keyFor(user, auth);
      if (!key) {
        throw new AgentError(
          'Settings need a signed-in user; this request has no verified identity.',
          {
            code: SETTINGS_IDENTITY_REQUIRED,
            status: 403,
            retryable: false,
            hint:
              'Authenticate the user, or configure installSettings with ' +
              'principalKey (or shared: true for a single-user server).',
          },
        );
      }
      const stored = await store.update(key, input.set as Partial<z.output<S>>);
      return {values: effective(stored as Record<string, unknown>)};
    }
  }

  const td = composeTeardown();
  const toolBinding = addTool(app, SettingsTools);
  td.push(() => unbindOwned(app, toolBinding));
  try {
    if ((options.advertise ?? ['openai']).includes('openai')) {
      const capability = {readTool: readName, updateTool: updateName};
      const installed = contributeCapabilities(app, {
        extensions: {[OPENAI_SETTINGS_CAPABILITY]: capability},
        experimental: {[OPENAI_SETTINGS_CAPABILITY]: capability},
      });
      td.push(() => installed.uninstall());
    }
    const toolItems = layout.flatMap(g =>
      g.items.filter(
        (i): i is Extract<typeof i, {kind: 'tool'}> => i.kind === 'tool',
      ),
    );
    if (toolItems.length) {
      const check = app.onStart(async () => {
        const mcp = (await app.get(MCPBindings.SERVER)) as MCPServer;
        const tools = mcp.servedTools();
        for (const item of toolItems) {
          const t = tools.find(x => x.meta.name === item.tool);
          if (!t) {
            throw new Error(
              `installSettings: layout tool '${item.tool}' is not a registered tool`,
            );
          }
          if (!accepts(t.meta.input, {})) {
            throw new Error(
              `installSettings: layout tool '${item.tool}' must accept {} — ` +
                `the settings page calls it with no arguments`,
            );
          }
        }
      });
      td.push(() => unbindOwned(app, check));
    }
  } catch (err) {
    await td.run();
    throw err;
  }
  return {uninstall: () => td.run()};
}
