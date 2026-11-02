/**
 * dsh-rewind client half: the `/rewind` command decoration, the locale
 * registration, and the session-scoped portal bridge that renders the
 * per-message ↶ rewind button (`portals.tsx` owns the button and the popover).
 *
 * The button registers through the harness's
 * `conversation.session.header.actions` slot — a typed structural registration,
 * so the plugin imports no conversation UI types and survives harness drift.
 * The command decoration (`ctx.commandUi.decorate`) makes a bare `/rewind` (or
 * its alias `/undo`) open the harness's own popupSelect instead of executing;
 * the parameterized `@<seq>` form stays the execution channel, while the
 * popover's impact and candidate reads go over the host RPC channel.
 *
 * @module dsh-rewind/client
 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
export declare const name = "dsh-rewind";
export declare const inject: string[];
/**
 * The client plugin root context read by `apply(ctx)`. Local structural face:
 * the harness client context is a cordis `Context` augmented by runtime
 * services, so the plugin declares the subset it reads. `sessions` is the real
 * `ISessions` from `@deepseek-ai/dsh-api-session-controller`.
 */
export interface ClientContext {
    effect(execute: (() => Iterable<unknown>) | (() => void), label?: string): unknown;
    locale: {
        register(namespace: string, messages: Record<string, Record<string, string>>): unknown;
        bind(namespace: string): (key: string) => string;
        subscribe(cb: () => void): () => void;
    };
    sessions: ISessions;
    get(name: string): unknown;
    slots: unknown;
    commandUi: unknown;
    /** Per-entry configuration forms (this bundle's own entry included). */
    configForms: {
        get<T>(entryId: string): ConfigForm<T>;
    };
}
/**
 * Client plugin body: command decoration + parameterized guard + locale + the
 * portal bridge.
 * @param ctx - client root context carrying `slots`, `sessions`, `locale` and `commandUi`.
 */
export declare function apply(ctx: ClientContext): void;
