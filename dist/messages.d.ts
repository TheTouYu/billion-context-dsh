/**
 * M1 — session-log projection: DSH surface events → acp-kernel CoreMessage.
 *
 * The ACP kernel is message-array based; DSH is event-log based. This module
 * is the bridge in the direction the engine needs (projectEvent /
 * eventsToCoreMessages). The reverse direction (CoreMessage[] → session
 * appends) is the M5 region transaction's job.
 * Mirrors billion-context-pi's `projectMessage`/`entriesToCoreMessages`
 * against DSH event shapes (see V-verification: SurfaceEventType =
 * 'user/message' | 'assistant/message' | 'tool/result').
 * @module billion-context-pi-dsh/messages
 */
import type { CoreMessage } from 'acp-kernel';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { MessageSource } from '@deepseek-ai/dsh-llm';
/**
 * Extract plain text from a DSH content block array or string.
 *
 * Recursive: a real DSH `tool-result` block is `{ type: 'tool-result',
 * toolCallId, content: ContentBlock[] }` — the inner `content` array holds
 * the actual `text` blocks, so a top-level-only walk would drop every tool
 * result from the projection (and with it the seq's ref assignment, breaking
 * compress boundary resolution). Nested arrays are flattened depth-first.
 */
export declare function extractText(content: unknown): string;
/**
 * The tool-call id of one tool/result surface message, or null.
 *
 * On the 0.1.7+/0.2.0 shape the id is the message's TOP-LEVEL
 * `toolCallId` (the nested `tool-result` content block no longer carries
 * it and the message role is `tool`); the legacy fallbacks stay because
 * sessions committed on the 0.1.5 line keep their old rows when resumed —
 * nested-block `toolCallId` first, then `message.source.callId` (which the
 * current line stamps on every tool/result anyway). Shared with
 * `src/region.ts`'s call/result pairing and the engine's compress-pair
 * hide — one implementation, never a copy (hard-won rule 10).
 */
export declare function toolCallIdOfResultEvent(event: SessionEvent): string | null;
/**
 * Index of assistant tool-call `id` → tool `name`, used to attribute
 * tool/result messages to their tool. Real DSH tool-results carry no
 * `message.toolName` (rule 10), so the projection backfills it from the
 * matching assistant tool-call. Scans ALL events up front (order-independent:
 * a result may precede its call in the array) and covers shadowed calls too.
 */
export declare function buildToolCallIndex(events: readonly SessionEvent[]): ReadonlyMap<string, string>;
/**
 * Project one surface message event into CoreMessage(s).
 *  - user/message      → user text (verbatim content)
 *  - assistant/message → assistant text, or one CoreMessage per tool-call
 *  - tool/result       → tool result (role 'tool'); toolName/toolCallId are
 *                        backfilled from `toolNames` (assistant tool-call
 *                        index) — real DSH events do not carry them at the
 *                        message level. Without an index the result stays
 *                        untagged (`toolName: ''`), never "text".
 * Non-surface events project to nothing.
 */
/**
 * B1 summary source framing. A compaction summary is MODEL-WRITTEN text, not
 * user words — injected as a user/message with the same standing as real input,
 * which let obligation sentences inside summaries read as user directives and
 * the model's own guesses read as user commitments. The frame says both things
 * up front. It is applied at creation (src/region.ts writes the framed blocks
 * to BOTH durable writes) and again at projection (below) as an idempotent
 * safety net for legacy blocks written before the feature.
 */
export declare const SUMMARY_FRAME_PREFIX = "[Model-written summary \u2014 not user words; re-verify any obligations before relying on them]";
export declare function withSummaryFramePrefix(text: string): string;
export declare function projectEvent(event: SessionEvent, toolNames?: ReadonlyMap<string, string>): CoreMessage[];
/** Project a session's message events into CoreMessage[] in log order. */
export declare function eventsToCoreMessages(events: readonly SessionEvent[], toolNames?: ReadonlyMap<string, string>): CoreMessage[];
/** The surface-visible message events of a session, in model-visible order. */
export declare function surfaceEventsOf(session: Session): SessionEvent[];
/**
 * ALL message-type events in log order — the visible surface PLUS everything
 * shadowed by compression. The ACP kernel deactivates any block whose consumed
 * message ids are absent from the array it is given (syncBlocks), and refuses
 * to anchor a block boundary that cannot find its messages, so T2/T3
 * distillation requires the full log, not just the visible surface.
 */
export declare function allLogMessages(session: import('@deepseek-ai/dsh-session').Session): CoreMessage[];
/** Extract the model-facing text of any surface message event. */
export declare function extractEventText(event: SessionEvent): string;
/**
 * Whether a surface user message is a compaction checkpoint node (already
 * compressed). Defined here (not in region.ts) so the classifier below and
 * region.ts share ONE implementation.
 */
export declare function isCheckpointNode(event: SessionEvent): boolean;
/**
 * The durable compaction id a checkpoint node carries, in EITHER host shape
 * (see {@link isCheckpointNode}). Shared by the region.ts seq/registry
 * readers so writer and readers can never disagree on identity; returns
 * undefined for plain messages and malformed checkpoints (no string id).
 */
export declare function checkpointCompactionIdOf(event: SessionEvent): string | undefined;
/**
 * Injection/authoring classification of one surface event — the ONE shared
 * classifier for range scanning and the protected-tail scan (never ad-hoc
 * predicates that drift apart).
 *
 * - `real` — genuine conversation content (user turns without an injected
 *   source, assistant prose/tool-calls, tool results, sub-agent relay rows).
 *   This is the only class that may win "last real user message" protection
 *   (minus relay rows, see `isRealUserTurn`).
 * - `metadata` — the engine's own ephemeral rows: nudge echoes and
 *   compress-pair replacement stubs. Their content is derived from
 *   already-visible messages, so folding them into an adjacent real segment
 *   is zero-loss — this preserves main's behavior for engine-authored rows.
 * - `checkpoint` — compaction summary nodes (`plugin: 'compact'`).
 *   Distillation is an explicit act; never folded into any segment.
 * - `instruction` — host-authored policy/instructions: AGENTS.md injections
 *   (both host shapes), skill catalogs, and ANY unknown `kind:'plugin'` row.
 *   Folding these is unsafe (the model would lose live policy text, and the
 *   host re-injects the current AGENTS.md copy when it disappears — the
 *   compress → re-inject loop this PR fixes). Unknown plugin names fall here
 *   deliberately: a future host injection must never silently become
 *   compressible content.
 */
export type SurfaceEventClass = 'real' | 'metadata' | 'checkpoint' | 'instruction';
/**
 * Plugin names the engine itself authors — safe to fold into real segments.
 * LEGACY shape only: 0.1.5 wrote `{ kind: 'plugin', plugin }`, which 0.1.7's
 * `assertV4SourceRowAdmission` now refuses, so this set exists to READ rows
 * already committed and never to author new ones. New writes carry the
 * producer-owned kind instead (see {@link engineSource}).
 */
export declare const METADATA_PLUGINS: ReadonlySet<string>;
/**
 * Producer-owned kinds for the same engine-authored rows, keyed the way 0.1.7
 * records them. `MessageSource.kind` answers *who produced this*, and the
 * format refuses the generic `{ kind: 'plugin', plugin }` wrapper outright
 * (`format v4 message requires a producer-owned source kind`). Kept in step
 * with {@link METADATA_PLUGINS} by {@link engineSource}, which is the only
 * writer.
 */
export declare const METADATA_KINDS: ReadonlySet<string>;
/**
 * Build the `source` for one engine-authored injected row. The single writer
 * for {@link METADATA_KINDS}, so a kind can never be authored that the
 * classifier below does not recognise as engine metadata.
 *
 * The kinds are declared in `MessageSourceMap` (augmentation below), so the
 * object the host's `user/message` validation and the session format see is
 * also the object the type system checks.
 */
export declare function engineSource(kind: 'acp-nudge' | 'billion-context-dsh', form: string): MessageSource;
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** Forced-nudge echo rows written by the engine (form 'nudge'). */
        'acp-nudge': {
            kind: 'acp-nudge';
            form: string;
        };
        /** Engine-authored replacement rows: the visible prune tombstone (form 'prune-tombstone'). */
        'billion-context-dsh': {
            kind: 'billion-context-dsh';
            form: string;
        };
    }
}
/**
 * True for AGENTS.md instruction rows in BOTH host shapes: the hook shape
 * (`kind:'agent-instructions'`, form 'instructions') and the baseline shape
 * (`kind:'plugin'` + plugin 'agent-instructions'). Shared by the newest-row
 * scan and the range scanner so protection and folding always agree on what
 * counts as an AGENTS.md row.
 */
export declare function isAgentInstructionsRow(event: SessionEvent): boolean;
export declare function classifySurfaceEvent(event: SessionEvent): SurfaceEventClass;
/**
 * Whether an event is a real user turn — the protected-tail criterion. An
 * injected row (AGENTS.md, skill catalog, nudge echo, tool notice) is real
 * *content* at most but is never the user speaking: the latest real user
 * message must keep its protection window even when an injected row lands
 * after it. The scan this replaces protected "the last non-checkpoint
 * user/message", which on live sessions is frequently an AGENTS.md injection
 * row (the host appends it in the same enter batch) — the actual last user
 * message was left compressible while synthetic output sat safe.
 */
export declare function isRealUserTurn(event: SessionEvent): boolean;
