/**
 * dsh-rewind host half: the `/rewind` command and the Claude-Code-style
 * checkpoint store, composed as one dual-face bundle row (the browser half
 * lives in `src/client/`).
 *
 * Rewind mechanism: planning is pure (`src/rewind.ts`); execution appends a
 * marker `user/message` whose `surfaceOp` replaces the target and every surface
 * node after it with itself, cutting only the model-visible surface
 * (`docs/architecture.md`).
 *
 * File restore (mode `both`) follows Claude Code's checkpointing: unless
 * `fileCheckpointingEnabled` is off, the plugin backs up each tracked
 * write-class edit BEFORE it happens (at the
 * `tools/execute` around-dispatch stage, so an approval short-circuit cannot
 * skip the capture and a denied call never records), commits the backup under
 * the turn's anchor message seq at `tools/post-execute`, and a rewind to
 * message N restores every backup anchored at or after N — modified files are
 * written back to their pre-edit content, files created after N are deleted.
 * Backups persist on disk under the dsh data directory (newest 100 message
 * groups per session), so restores work after a host restart, and they
 * read/write the real file system with plain `node:fs` — independent of the
 * fs service. See `src/snapshot.ts`.
 *
 * @module dsh-rewind
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type CleanupSettings } from './snapshot-cleanup.ts';
export { SnapshotStore } from './snapshot.ts';
export type { CheckpointEntry, FileImpact, PruneStaleReport, RestoreOutcome, RestoreJournal, RestoreJournalState, RestoreReconcileReport } from './snapshot.ts';
export declare const name = "dsh-rewind";
export declare const inject: string[];
/**
 * The internal engine channel the client drives, so the rewind surface never
 * depends on a name a third-party plugin can take. Mirrored by `ENGINE_COMMAND`
 * in `src/client/hidden.ts` — the two bundles share no module.
 */
export declare const ENGINE_COMMAND = "rewind-plugin";
/** Plugin config. */
export interface RewindConfig {
    /** Checkpoint store root (exact path; beats the harness-home default). */
    readonly snapshotDir?: string;
    /** Harness home override (`config.dshHome` > `$DSH_HOME` > `~/.dsh`); feeds the default snapshot/cleanup paths. */
    readonly dshHome?: string;
    /** In-place content dedup (identical before-content → link). Default `true`. */
    readonly dedup?: boolean;
    /** Per-file backup cap in bytes; `0` disables the cap. Default {@link DEFAULT_MAX_FILE_BYTES}. */
    readonly maxFileBytes?: number;
    /** Newest anchor groups (user messages) kept per session. Default {@link MAX_ANCHOR_GROUPS}. */
    readonly maxAnchorGroups?: number;
    /** Automatic snapshot-sweep cadence in ms. Default {@link AUTO_SWEEP_INTERVAL_MS}. */
    readonly autoSweepIntervalMs?: number;
}
/** The default for {@link FileCheckpointingSettings.fileCheckpointingEnabled}. */
export declare const DEFAULT_FILE_CHECKPOINTING_ENABLED = true;
/**
 * The live file-checkpointing switch (Claude Code's
 * `fileCheckpointingEnabled`): whether NEW before-backups may be recorded.
 */
export interface FileCheckpointingSettings {
    readonly fileCheckpointingEnabled: Volatile<boolean>;
}
/**
 * The plugin's full configuration: store options plus the three user-editable
 * policy fields. `.volatile()` resolves them into live references for the
 * Plugins page; the names say what they gate, because a bare `enabled` would
 * read like the entry's own `disabled:` flag.
 */
export interface Config extends RewindConfig, CleanupSettings, FileCheckpointingSettings {
}
/** The `Config` schema the host resolves and projects as this entry's form. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    snapshotDir: z<string, string, "plain">;
    dshHome: z<string, string, "plain">;
    dedup: z<boolean, boolean, "defined">;
    maxFileBytes: z<number, number, "defined">;
    maxAnchorGroups: z<number, number, "defined">;
    autoSweepIntervalMs: z<number, number, "defined">;
    fileCheckpointingEnabled: z<boolean, boolean, "volatile-defined">;
    autoCleanupEnabled: z<boolean, boolean, "volatile-defined">;
    autoCleanupMaxAgeDays: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    snapshotDir: z<string, string, "plain">;
    dshHome: z<string, string, "plain">;
    dedup: z<boolean, boolean, "defined">;
    maxFileBytes: z<number, number, "defined">;
    maxAnchorGroups: z<number, number, "defined">;
    autoSweepIntervalMs: z<number, number, "defined">;
    fileCheckpointingEnabled: z<boolean, boolean, "volatile-defined">;
    autoCleanupEnabled: z<boolean, boolean, "volatile-defined">;
    autoCleanupMaxAgeDays: z<number, number, "volatile-defined">;
}>>, "plain">;
/**
 * The settings entry id this plugin's configuration is addressed by: the PROFILE
 * ROW id from the bundle's patch, not this fiber's nested include id. The loader
 * mounts a bundle's rows under an `include:` scope, so the fiber id carries that
 * prefix while the configuration editor keys entries and profile patches by the
 * bare row id.
 * @param entryId - this fiber's Loader entry id, when it has one.
 * @returns the configuration key, or undefined without an entry.
 */
export declare function profileEntryKey(entryId: string | undefined): string | undefined;
/**
 * Register the `/rewind` command and the checkpoint pipeline (before-capture
 * at `tools/execute`, disk commit at `tools/post-execute`).
 *
 * The command is fs-independent and registers immediately. The checkpoint
 * pipeline needs `fs` to resolve tracked paths to their real display paths,
 * so it mounts through a dynamic `ctx.inject(['fs'])` — it takes effect
 * whenever the fs service becomes available (and never fails the plugin's
 * load when a deployment has no fs; without it, no entries are recorded and
 * `both` restores report "no tracked changes").
 *
 * Capture runs in `tools/execute` (the around-dispatch stage), NOT in
 * `tools/pre-execute`: a pre-execute `{ kind: 'ask' }` short-circuit from
 * another plugin (e.g. dsh-edit-approval) skips later pre-execute listeners,
 * and a denied call never dispatches — so approved calls are still captured,
 * denied calls never leave a pending entry behind. Entries are committed to
 * disk at `tools/post-execute` under the turn's anchor message seq.
 *
 * @param ctx - context carrying `commands`, `tools`, and an optional `fs`.
 * @param config - resolved plugin config: the store options (`snapshotDir`,
 *  `dshHome`, `dedup`) plus the live policy (`fileCheckpointingEnabled`, cleanup
 *  `enabled`/`maxAgeDays`).
 */
export declare function apply(ctx: Context, config?: Config): void;
