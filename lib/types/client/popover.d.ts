/**
 * The rewind mode-selection popover (plain DOM, no React). Step two of the
 * interaction: the target is already fixed (the clicked message); the popover
 * offers the two modes. Choosing "both" fetches the impact list over the host
 * RPC channel and shows it before confirming.
 *
 * Keyboard: ↑/↓ move focus across the step's ACTION buttons only (the two
 * modes, or the confirm button on the impact step), Enter activates the
 * focused button (native), Esc is the keyboard twin of the ghost back/cancel
 * buttons — cancel on the modes step, back on the impact step; the ghosts are
 * never in the arrow cycle. The listener runs in the document capture phase
 * so the keys are stolen from the composer while the popover is open.
 *
 * @module dsh-rewind/client/popover
 */
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client';
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { type ChatOf } from './hidden.ts';
import type { PreviewCall } from './host-rpc.ts';
import type { RewindKey } from './locales.ts';
type Translate = (key: RewindKey, params?: Record<string, unknown>) => string;
export interface PopoverOptions {
    readonly session: SessionFace;
    /** Durable variant: the target message seq (mode-selection flow). */
    readonly seq?: number;
    /** Durable variant: the target message time. */
    readonly time?: number;
    /** Pending variant: retract a pre-sent steering message (single-confirm flow). */
    readonly retract?: {
        readonly itemId: string;
        readonly text: string | null;
    };
    /** Pending variant: executed after the retract confirm closes the popover. */
    readonly onRetract?: () => void;
    readonly preview: string;
    /** The button that opened the popover (outside-click ignore target). */
    readonly anchor: HTMLElement;
    readonly t: Translate;
    /**
     * Execute one rewind in the given mode. The popover closes itself first;
     * the callback owns the command + composer-refill lifecycle (see
     * runRewindAndFill in index.ts).
     */
    readonly onRewind?: (mode: 'chat' | 'both') => void;
}
/**
 * Register the composer focus channel (called once by the client plugin).
 * @param focus - returns the keyboard to one session's composer, caret included.
 */
export declare function registerComposerFocuser(focus: (sessionId: string) => void): void;
/** Close the current popover, if any, handing the keyboard back to its composer. */
export declare function closePopover(): void;
/**
 * Seqs of the command nodes currently matching `match`. Sample BEFORE issuing
 * a new command of the same shape so the subsequent wait can exclude them: a
 * repeated rewind of the same target must not settle on the previous command's
 * stale outcome.
 */
export declare function knownCommandSeqs(session: SessionFace, chatOf: ChatOf, match: (node: CommandNode) => boolean): Set<number>;
/**
 * Resolve the outcome of the newest matching rewind command by watching the
 * session snapshot (command/run + command/done land as one CommandNode).
 * @returns the outcome text-bearing node, or null on timeout.
 */
export declare function waitForCommand(session: SessionFace, chatOf: ChatOf, match: (node: CommandNode) => boolean, timeoutMs: number | undefined, watch: (cb: () => void) => () => void): Promise<{
    kind: 'success' | 'error';
    text?: string;
} | null>;
/** Register the host RPC preview call (null clears it on unload). */
export declare function registerPreviewCall(call: PreviewCall | null): void;
/** Open the mode-selection popover anchored near the given button. */
export declare function openPopover(opts: PopoverOptions): void;
export {};
