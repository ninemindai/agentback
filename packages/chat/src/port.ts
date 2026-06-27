// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The chat-platform **port**: the minimal structural surface `@agentback/chat`
 * needs from a chat runtime. Vercel's Chat SDK `Chat` instance satisfies this
 * by shape, so the package takes **no dependency on `chat`** — the port IS the
 * insulation layer. A consumer passes their real `new Chat({...})` to
 * {@link installChat}; structural typing checks the fit.
 *
 * Keeping this a hand-written subset (rather than importing Chat SDK types)
 * means Chat SDK's churn — it is public beta — lands here, in one file, instead
 * of leaking into user-facing signatures.
 */

/** A loosely-typed event handler as the chat runtime will call it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChatRuntimeHandler = (...args: any[]) => unknown | Promise<unknown>;

/** Fetch-native webhook handler: `(Request) => Promise<Response>`. */
export type ChatWebhookFn = (
  request: Request,
  options?: {waitUntil?: (p: Promise<unknown>) => void},
) => Promise<Response>;

/**
 * The subset of a chat runtime (Vercel Chat SDK `Chat`) the framework drives.
 * Event-registration methods are optional so older/newer runtimes that omit one
 * still satisfy the port — {@link ChatServer.register} guards each before use.
 */
export interface ChatLike {
  onNewMention?(handler: ChatRuntimeHandler): void;
  onSubscribedMessage?(handler: ChatRuntimeHandler): void;
  onDirectMessage?(handler: ChatRuntimeHandler): void;
  onAction?(handler: ChatRuntimeHandler): void;
  onReaction?(handler: ChatRuntimeHandler): void;
  onSlashCommand?(handler: ChatRuntimeHandler): void;
  /** Per-adapter fetch-native webhook handlers, keyed by adapter name. */
  readonly webhooks: Record<string, ChatWebhookFn>;
  /** Graceful shutdown; wired to `app.onStop()` by {@link installChat}. */
  shutdown(): Promise<void>;
}

/**
 * A platform-neutral conversation handle (structural subset of Chat SDK's
 * `Thread`). Type a `@chatBot` method's first parameter with this for
 * autocomplete without importing `chat`.
 */
export interface ChatThread {
  post(content: unknown): Promise<unknown>;
  subscribe?(): Promise<unknown>;
  readonly id?: string;
}

/** A platform-neutral inbound message (structural subset of Chat SDK's `Message`). */
export interface ChatMessage {
  readonly text?: string;
  readonly isMention?: boolean;
  /** Who sent it (`message.author`). */
  readonly author?: ChatSender;
}

/**
 * The identity of whoever produced an event — `message.author` for messages,
 * `event.user` for actions/reactions (structural subset of Chat SDK's `Author`).
 * A {@link ChatPrincipalResolver} maps this to a `UserProfile`.
 */
export interface ChatSender {
  readonly userId: string;
  readonly userName?: string;
  readonly fullName?: string;
  readonly isBot?: boolean | 'unknown';
  readonly isMe?: boolean;
}

// Event handles for the non-message events. Kept as loose, all-optional
// structural subsets so a handler typed with the real Chat SDK event (a
// superset) still satisfies the decorator's signature constraint — the package
// takes no `chat` dependency, so it can't reference the SDK types directly.

/** Interactive action — button click, etc. (subset of Chat SDK's `ActionEvent`). */
export interface ChatActionEvent {
  readonly actionId?: string;
  readonly thread?: ChatThread | null;
  readonly user?: ChatSender;
}

/** Reaction add/remove (subset of Chat SDK's `ReactionEvent`). */
export interface ChatReactionEvent {
  readonly thread?: ChatThread | null;
  readonly emoji?: string;
  readonly user?: ChatSender;
}

/** Slash command invocation (subset of Chat SDK's `SlashCommandEvent`). */
export interface ChatSlashCommandEvent {
  readonly command?: string;
  readonly thread?: ChatThread | null;
  readonly user?: ChatSender;
}
