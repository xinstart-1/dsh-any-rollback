/**
 * The browser half of the rewind RPC channel: the mode popover's impact
 * preview and the `/rewind` candidate list. Both are read-only host queries,
 * so they travel over Connection RPC instead of the human command channel.
 *
 * @module dsh-rewind/client/host-rpc
 */
import type { RewindCandidate } from './candidates.ts';
/** One file affected by a rewind. */
export interface PreviewFileImpact {
    readonly path: string;
    readonly action: 'restore' | 'delete';
}
/** One impact probe resolved, failed, or timed out (`null`). */
export type PreviewOutcome = {
    readonly kind: 'success';
    readonly files: readonly PreviewFileImpact[];
    readonly backupOff: boolean;
} | {
    readonly kind: 'error';
    readonly text: string;
} | null;
/** Fetch one target's impact through the registered RPC call. */
export type PreviewCall = (sessionId: string, seq: number) => Promise<PreviewOutcome>;
type RpcResult = {
    readonly ok: true;
    readonly value: unknown;
} | {
    readonly ok: false;
    readonly error: {
        readonly code: string;
        readonly message: string;
    };
};
/** The slice of the client `connection` service this module reads. */
export interface ConnectionLike {
    readonly rpc: {
        call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>;
    };
}
/** Resolve one target's file impact over RPC. */
export declare function previewOverRpc(connection: ConnectionLike | undefined, sessionId: string, seq: number): Promise<PreviewOutcome>;
/** Fetch the full rewind candidate list over RPC. */
export declare function candidatesOverRpc(connection: ConnectionLike | undefined, sessionId: string): Promise<readonly RewindCandidate[] | undefined>;
export {};
