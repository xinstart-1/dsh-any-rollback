/**
 * Pure pending-message matching: pairs the rendered pre-admission steering
 * bubble rows with the session's `next-step` inbox rows.
 *
 * Both sides follow the same host order, so index-primary matching is reliable;
 * the match key is still verified per row, and a row that fails (or has no
 * counterpart) is skipped INDIVIDUALLY: one bad row never takes down the other
 * rows' buttons. The key is `(text, attachment count)`: exact text for a
 * text-only message, the count for one that carries attachments — whose
 * rendered attachment block contributes text no inbox row reproduces.
 *
 * The compared text excludes the bubble's actions container and its
 * message-attachment block (see `bubbleTextOf` in portals.tsx).
 *
 * The browser half lives in `portals.tsx`; this module stays DOM-free so the
 * matching contract is unit-testable in a plain node environment.
 *
 * @module dsh-rewind/client/pending
 */
/** One rendered pending-steering bubble row (only the fields matching reads). */
export interface PendingRow {
    /** The bubble's message text, excluding the actions container (see module doc). */
    readonly text: string;
    /** Message-attachment blocks the row renders; compared against the item's count. */
    readonly attachments: number;
}
/** One wire content block of an inbox row (only the fields the derivation reads). */
export interface InboxBlockLike {
    /** Wire block type (`text` | `image` | `file` | …). */
    readonly type: string;
    /** The block's text, on a `text` block. */
    readonly text?: string;
}
/** One pending-inbox row (the alpha.2 `inbox` projection element). */
export interface InboxMessageLike {
    /** Agent-owned inbox occurrence identity; the harness brands it as `MessageId`. */
    readonly id: string;
    /** Wire content blocks, in prompt order. */
    readonly content: readonly InboxBlockLike[];
    /** Message origin; only `kind: 'user'` rows are retractable (see `steeringItemsOf`). */
    readonly source?: {
        readonly kind?: string;
    } | undefined;
}
/**
 * The alpha.2 `inbox` projection value: the agent's pending input folded per
 * target order. Replaces the removed `SessionSnapshot.queue` mirror.
 */
export interface InboxLike {
    /** Messages claimed at the next turn boundary. */
    readonly 'next-turn': readonly InboxMessageLike[];
    /** Messages injected at the next step boundary (user or plugin/command). */
    readonly 'next-step': readonly InboxMessageLike[];
}
/** One steering occurrence derived from the session's inbox projection. */
export interface PendingSteeringItem {
    readonly id: string;
    /** Complete editable text; null when the message carries no text block at all. */
    readonly text: string | null;
    /** Non-text blocks (image/file/…) the message carries, in prompt order. */
    readonly attachments: number;
    /** Space-collapsed preview with image/file blocks excluded (the harness QueueDock rule). */
    readonly preview: string;
}
/**
 * Project the inbox `next-step` rows into the fields the retract path needs.
 *
 * ONLY user-sourced rows are steering: the host's deleted mapping
 * (`queueItemsFromInbox`) called a `next-step` row `steering` for
 * `source.kind === 'user'` and `context` otherwise, and this plugin has only
 * ever retracted the former. An injected row must not get a button, and because
 * `retractSpan` removes the target AND its future it must not be swept into a
 * retract either; keeping it would also shift the positional match against the
 * rendered submission echoes and cost every later row its button.
 * @param nextStep - the inbox projection's `next-step` list (absent before the
 *   fold state exists, hence `undefined`).
 * @returns one item per USER steering row, in host (FIFO) order.
 */
export declare function steeringItemsOf(nextStep: readonly InboxMessageLike[] | undefined): readonly PendingSteeringItem[];
/**
 * Pair rows to steering items by index, verifying the match key per row: the
 * visible text when the message has no attachments, otherwise the attachment
 * count. Exact text equality cannot apply to an attachment-bearing row — which
 * is why its ↶ button never mounted — because the rendered attachment block
 * contributes text no inbox row reproduces.
 *
 * @param rows - pending bubble rows in DOM order (== render order).
 * @param steering - steering items in host order (== render order).
 * @returns the item id for each row, or null for rows that cannot be matched
 *   safely (missing counterpart, key mismatch). A bad row never affects the
 *   other rows.
 */
export declare function matchPendingRows(rows: readonly PendingRow[], steering: readonly PendingSteeringItem[]): readonly (string | null)[];
/**
 * The pending-steering ids a "rewind to this pre-sent message" retracts: the
 * target occurrence and every steering message after it, in inbox (FIFO)
 * order. Queued (next-turn) messages are deliberately NOT included — the
 * harness QueueDock already offers the user per-item edit/remove, so a rewind
 * must not silently drop messages the user may still want to send.
 * @param steering - steering items in host order (== render order).
 * @param targetId - the rewind target's inbox occurrence id.
 * @returns the ids to remove, oldest-first; empty when the target is no
 *   longer pending (already claimed/consumed).
 */
export declare function retractSpan(steering: readonly {
    readonly id: string;
}[], targetId: string): readonly string[];
