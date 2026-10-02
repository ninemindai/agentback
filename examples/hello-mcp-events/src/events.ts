// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey, inject} from '@agentback/context';
import {
  event,
  MCPBindings,
  mcpServer,
  tool,
  type McpEventEmitter,
} from '@agentback/mcp';
import {z} from 'zod';

// ─── Schemas: one source of truth for the tool, the event and the payload ───

/** Subscription arguments: which document to watch. */
export const CommentFilter = z.object({
  document_id: z.string().describe('The document whose comments to watch.'),
});

/**
 * What a subscriber receives. A summary plus the id the `get_comment` tool
 * takes — never the whole record (deliveries are capped at 256 KiB) and never
 * instructions for a model: the receiving agent treats `data` as untrusted.
 */
export const CommentCreated = z.object({
  document_id: z.string(),
  comment_id: z.string(),
  preview: z.string().describe('The first 140 characters of the comment.'),
});

const AddCommentIn = z.object({
  document_id: z.string(),
  text: z.string().min(1).max(10_000),
});
const Comment = z.object({
  comment_id: z.string(),
  document_id: z.string(),
  author: z.string(),
  text: z.string(),
});

// ─── A tiny in-memory comment store ─────────────────────────────────────────

export class CommentStore {
  private readonly comments = new Map<string, z.infer<typeof Comment>>();
  add(c: Omit<z.infer<typeof Comment>, 'comment_id'>) {
    const comment = {comment_id: `c_${this.comments.size + 1}`, ...c};
    this.comments.set(comment.comment_id, comment);
    return comment;
  }
  get(id: string) {
    return this.comments.get(id);
  }
}

export const COMMENTS = BindingKey.create<CommentStore>('services.comments');

// ─── The event type ─────────────────────────────────────────────────────────

@mcpServer()
export class DocEvents {
  /**
   * `@event` is to an event type what `@tool` is to a tool: a name plus Zod
   * schemas, projected as `inputSchema`/`payloadSchema` on `events/list`. The
   * method is the server-side filter — deliver to a subscription only when it
   * returns `true`.
   */
  @event('comment.created', {
    description: 'A new review comment was added to the specified document.',
    input: CommentFilter,
    payload: CommentCreated,
    scope: 'docs:read',
  })
  matches(
    args: z.infer<typeof CommentFilter>,
    e: z.infer<typeof CommentCreated>,
  ) {
    return e.document_id === args.document_id;
  }
}

// ─── Tools: the write that emits, and the read a subscriber follows up with ─

@mcpServer()
export class CommentTools {
  constructor(@inject(COMMENTS) private readonly store: CommentStore) {}

  @tool('add_comment', {
    description: 'Add a review comment to a document.',
    input: AddCommentIn,
    output: Comment,
  })
  async addComment(
    input: z.infer<typeof AddCommentIn>,
    @inject(MCPBindings.EVENTS) events: McpEventEmitter,
  ) {
    const comment = this.store.add({...input, author: 'demo'});
    // Validated against CommentCreated here; every live subscription whose
    // `matches` accepts it gets a signed webhook POST.
    await events.emit(
      'comment.created',
      {
        document_id: comment.document_id,
        comment_id: comment.comment_id,
        preview: comment.text.slice(0, 140),
      },
      {eventId: `evt_${comment.comment_id}`},
    );
    return comment;
  }

  @tool('get_comment', {
    description:
      'Read one comment by id (follow up on a comment.created event).',
    input: z.object({comment_id: z.string()}),
    output: Comment,
  })
  getComment(input: {comment_id: string}) {
    const c = this.store.get(input.comment_id);
    if (!c) throw new Error('not found');
    return c;
  }
}
