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

import type { CoreMessage } from 'acp-kernel'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { eventAtOf, sessionEventsOf } from './session-events.ts'

/**
 * Extract plain text from a DSH content block array or string.
 *
 * Recursive: a real DSH `tool-result` block is `{ type: 'tool-result',
 * toolCallId, content: ContentBlock[] }` — the inner `content` array holds
 * the actual `text` blocks, so a top-level-only walk would drop every tool
 * result from the projection (and with it the seq's ref assignment, breaking
 * compress boundary resolution). Nested arrays are flattened depth-first.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; content?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (Array.isArray(b.content)) {
      parts.push(extractText(b.content))
    }
  }
  return parts.join('\n')
}

interface ToolCallBlock {
  type: 'tool-call'
  id?: string
  name?: string
  arguments?: unknown
}

function toolCallsOf(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((b): b is ToolCallBlock => (b as { type?: string }).type === 'tool-call')
}

function stringifyArgs(args: unknown): string {
  if (!args) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

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
export function toolCallIdOfResultEvent(event: SessionEvent): string | null {
  if (event.type !== 'tool/result') return null
  const message = (event.data as {
    message?: {
      toolCallId?: unknown
      content?: ReadonlyArray<{ type?: unknown; toolCallId?: unknown }>
      source?: { callId?: unknown }
    }
  }).message
  if (message === undefined) return null
  const block = Array.isArray(message.content)
    ? message.content.find((candidate) => candidate?.type === 'tool-result')
    : undefined
  const id = message.toolCallId ?? block?.toolCallId ?? message.source?.callId
  return typeof id === 'string' ? id : null
}

/**
 * Index of assistant tool-call `id` → tool `name`, used to attribute
 * tool/result messages to their tool. Real DSH tool-results carry no
 * `message.toolName` (rule 10), so the projection backfills it from the
 * matching assistant tool-call. Scans ALL events up front (order-independent:
 * a result may precede its call in the array) and covers shadowed calls too.
 */
export function buildToolCallIndex(events: readonly SessionEvent[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const content = (event.data as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const candidate = block as { type?: unknown; id?: unknown; name?: unknown } | null
      if (candidate !== null && typeof candidate === 'object' && candidate.type === 'tool-call' && typeof candidate.id === 'string') {
        index.set(candidate.id, typeof candidate.name === 'string' ? candidate.name : '')
      }
    }
  }
  return index
}

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
export const SUMMARY_FRAME_PREFIX = '[Model-written summary — not user words; re-verify any obligations before relying on them]'

export function withSummaryFramePrefix(text: string): string {
  return text.startsWith(SUMMARY_FRAME_PREFIX) ? text : `${SUMMARY_FRAME_PREFIX}\n${text}`
}

export function projectEvent(event: SessionEvent, toolNames?: ReadonlyMap<string, string>): CoreMessage[] {
  switch (event.type) {
    case 'user/message': {
      const raw = extractText((event.data as { content?: unknown }).content)
      // B1: frame compaction summaries at projection too (idempotent — creation-time
      // framing already covers new blocks; this catches legacy blocks whose nodes
      // were written before the feature existed).
      const text = isCheckpointNode(event) ? withSummaryFramePrefix(raw) : raw
      return text.length > 0 ? [{ id: String(event.seq), role: 'user', contentType: 'text', text }] : []
    }
    case 'assistant/message': {
      const content = (event.data as { message?: { content?: unknown } }).message?.content
      const calls = toolCallsOf(content)
      const text = extractText(content)
      if (calls.length === 0) {
        return text.trim().length > 0
          ? [{ id: String(event.seq), role: 'assistant', contentType: 'text', text }]
          : []
      }
      if (calls.length === 1) {
        const call = calls[0]!
        const argStr = stringifyArgs(call.arguments)
        const body = argStr && text ? `${text}\n${argStr}` : argStr || text
        return [{
          id: String(event.seq),
          role: 'assistant',
          contentType: 'tool-call',
          toolName: call.name ?? '',
          toolCallId: call.id ?? '',
          text: body,
        }]
      }
      return calls.map((call) => ({
        id: `${event.seq}#${call.id ?? ''}`,
        role: 'assistant' as const,
        contentType: 'tool-call' as const,
        toolName: call.name ?? '',
        toolCallId: call.id ?? '',
        text: stringifyArgs(call.arguments) || text,
      }))
    }
    case 'tool/result': {
      const message = (event.data as {
        message?: { content?: unknown; toolName?: string; toolCallId?: string }
      }).message
      const text = extractText(message?.content)
      if (text.length === 0) return []
      const key = toolCallIdOfResultEvent(event)
      return [{
        id: String(event.seq),
        role: 'tool',
        contentType: 'tool-result',
        toolName: toolNames?.get(key ?? '') ?? '',
        toolCallId: message?.toolCallId ?? key ?? '',
        text,
      }]
    }
    default:
      return []
  }
}

/** Project a session's message events into CoreMessage[] in log order. */
export function eventsToCoreMessages(events: readonly SessionEvent[], toolNames?: ReadonlyMap<string, string>): CoreMessage[] {
  const index = toolNames ?? buildToolCallIndex(events)
  const out: CoreMessage[] = []
  for (const event of events) out.push(...projectEvent(event, index))
  return out
}

/** The surface-visible message events of a session, in model-visible order. */
export function surfaceEventsOf(session: Session): SessionEvent[] {
  return session.surface.nodes
    .map((seq) => eventAtOf(session, seq))
    .filter((event): event is SessionEvent => event !== undefined)
}

/**
 * ALL message-type events in log order — the visible surface PLUS everything
 * shadowed by compression. The ACP kernel deactivates any block whose consumed
 * message ids are absent from the array it is given (syncBlocks), and refuses
 * to anchor a block boundary that cannot find its messages, so T2/T3
 * distillation requires the full log, not just the visible surface.
 */
export function allLogMessages(session: import('@deepseek-ai/dsh-session').Session): CoreMessage[] {
  return eventsToCoreMessages(sessionEventsOf(session))
}

/** Extract the model-facing text of any surface message event. */
export function extractEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return extractText((event.data as { content?: unknown }).content)
    case 'assistant/message':
      return extractText((event.data as { message?: { content?: unknown } }).message?.content)
    case 'tool/result':
      return extractText((event.data as { message?: { content?: unknown } }).message?.content)
    default:
      return ''
  }
}

/**
 * Whether a surface user message is a compaction checkpoint node (already
 * compressed). Defined here (not in region.ts) so the classifier below and
 * region.ts share ONE implementation.
 */
export function isCheckpointNode(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
  // 0.1.7+ stamps `{ kind: 'compact-checkpoint' }` (what
  // `compactCheckpointSource` from dsh-compaction writes — our own checkpoint
  // writer uses that helper); 0.1.5 stamped `{ kind: 'plugin', plugin:
  // 'compact' }`. Both are read: sessions committed before the upgrade still
  // carry the legacy row, and a checkpoint that stops classifying as one
  // becomes foldable — distillation is an explicit act. Shape-level only: a
  // node missing its compactionId is malformed but STILL a checkpoint.
  return source?.kind === 'compact-checkpoint' || source?.plugin === 'compact'
}

/**
 * The durable compaction id a checkpoint node carries, in EITHER host shape
 * (see {@link isCheckpointNode}). Shared by the region.ts seq/registry
 * readers so writer and readers can never disagree on identity; returns
 * undefined for plain messages and malformed checkpoints (no string id).
 */
export function checkpointCompactionIdOf(event: SessionEvent): string | undefined {
  if (!isCheckpointNode(event)) return undefined
  const source = (event.data as { source?: { compactionId?: unknown } }).source
  return typeof source?.compactionId === 'string' ? source.compactionId : undefined
}

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
export type SurfaceEventClass = 'real' | 'metadata' | 'checkpoint' | 'instruction'

/**
 * Plugin names the engine itself authors — safe to fold into real segments.
 * LEGACY shape only: 0.1.5 wrote `{ kind: 'plugin', plugin }`, which 0.1.7's
 * `assertV4SourceRowAdmission` now refuses, so this set exists to READ rows
 * already committed and never to author new ones. New writes carry the
 * producer-owned kind instead (see {@link engineSource}).
 */
export const METADATA_PLUGINS: ReadonlySet<string> = new Set([
  'acp-nudge', // nudge echo (src/nudge.ts)
  'billion-context-dsh', // compress-pair replacement stub (src/region.ts)
])

/**
 * Producer-owned kinds for the same engine-authored rows, keyed the way 0.1.7
 * records them. `MessageSource.kind` answers *who produced this*, and the
 * format refuses the generic `{ kind: 'plugin', plugin }` wrapper outright
 * (`format v4 message requires a producer-owned source kind`). Kept in step
 * with {@link METADATA_PLUGINS} by {@link engineSource}, which is the only
 * writer.
 */
export const METADATA_KINDS: ReadonlySet<string> = new Set([
  'acp-nudge',
  'billion-context-dsh',
])

/**
 * Build the `source` for one engine-authored injected row. The single writer
 * for {@link METADATA_KINDS}, so a kind can never be authored that the
 * classifier below does not recognise as engine metadata.
 *
 * The kinds are declared in `MessageSourceMap` (augmentation below), so the
 * object the host's `user/message` validation and the session format see is
 * also the object the type system checks.
 */
export function engineSource(kind: 'acp-nudge' | 'billion-context-dsh', form: string): MessageSource {
  return { kind, form }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Forced-nudge echo rows written by the engine (form 'nudge'). */
    'acp-nudge': { kind: 'acp-nudge'; form: string }
    /** Engine-authored replacement rows: the visible prune tombstone (form 'prune-tombstone'). */
    'billion-context-dsh': { kind: 'billion-context-dsh'; form: string }
  }
}

/**
 * Host plugins whose rows are real CONTENT, not policy: folding them reclaims
 * tokens and provokes nothing, so they fold exactly like an assistant turn.
 *  - '@deepseek-ai/dsh-system-prompt' (dsh-agent-loop): dynamic-context
 *    snapshot rows. The host appends a new row only when the snapshot TEXT
 *    changes (`if (this.retained?.text === snapshot) return`), so removing an
 *    old row never re-appends it — long sessions just accumulate them.
 *  - 'user-approval' (dsh-user-approval): one-shot approval-policy notice.
 *  - 'tools-ptc' (dsh-tools): deferred tool context, can carry image blocks.
 * A plugin NOT listed here still falls to 'instruction' below, so a future
 * presence-driven injection channel stays protected by default (issue #71
 * review B2).
 */
const REAL_CONTENT_PLUGINS: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-system-prompt',
  'user-approval',
  'tools-ptc',
])

/**
 * The same host content rows under their producer-owned kinds (0.1.7+/0.2.0).
 * The upgrade renamed every one of them, so keying only on the legacy names
 * would misfile each as an unknown policy row — snapshot rows would stop
 * folding and the protection window would refuse them for the wrong reason.
 * Names come from the format's own migration tables (`RENAMED_PRODUCERS` for
 * the three that changed, `RELEASED_SAME_NAME_PRODUCERS` for the rest) plus
 * the 0.2.0 seam's own `MessageSourceMap` augmentations:
 *  - 'runtime-context' — was '@deepseek-ai/dsh-system-prompt' (dsh-agent-loop;
 *    time/tmux sections ride inside these snapshots as `form:'snapshot'`
 *    sections, not as separate kinds)
 *  - 'ptc-mode' — was 'tools-ptc' / 'tools-code-mode' (dsh-tools, deferred
 *    images)
 *  - 'user-approval' — unchanged name, new kind (dsh-user-approval)
 *  - 'model-selection' — model switch notices (dsh-agent): event-driven
 *    appends, never presence-reinjected, so folding reclaims tokens with no
 *    re-inject loop (issue #71's danger class is unconditional re-injection)
 *  - 'tool-registry' — tool availability changes (dsh-tools): same
 *    event-driven nature as model-selection
 */
const REAL_CONTENT_KINDS: ReadonlySet<string> = new Set([
  'runtime-context',
  'ptc-mode',
  'user-approval',
  'model-selection',
  'tool-registry',
])

/** Known host policy kinds that must never be folded (safe-listing beyond `plugin`). */
const HOST_INSTRUCTION_KINDS: ReadonlySet<string> = new Set([
  'agent-instructions', // AGENTS.md injection (hook shape: {kind:'agent-instructions', form:'instructions'})
  'skill-catalog', // skill catalog (form:'catalog')
])

/**
 * True for AGENTS.md instruction rows in BOTH host shapes: the hook shape
 * (`kind:'agent-instructions'`, form 'instructions') and the baseline shape
 * (`kind:'plugin'` + plugin 'agent-instructions'). Shared by the newest-row
 * scan and the range scanner so protection and folding always agree on what
 * counts as an AGENTS.md row.
 */
export function isAgentInstructionsRow(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
  if (!source) return false
  return source.kind === 'agent-instructions' || (source.kind === 'plugin' && source.plugin === 'agent-instructions')
}

export function classifySurfaceEvent(event: SessionEvent): SurfaceEventClass {
  // Compaction summary nodes first — they are user messages too.
  if (isCheckpointNode(event)) return 'checkpoint'
  // Assistant / tool events are always genuine content.
  if (event.type !== 'user/message') return 'real'
  const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
  if (!source) return 'real' // user turn written without a source: genuine content
  const kind = source.kind
  if (kind === 'user') return 'real' // real user turn (host stamps {kind:'user'})
  // Producer-owned kinds first: this is what 0.1.7 writes, and it is the only
  // shape that reaches a new session's log at all.
  if (kind !== undefined && METADATA_KINDS.has(kind)) return 'metadata'
  if (kind !== undefined && REAL_CONTENT_KINDS.has(kind)) return 'real'
  // Legacy `kind:'plugin'` — read-only path for rows committed by 0.1.5.
  if (kind === 'plugin') {
    if (source.plugin !== undefined && METADATA_PLUGINS.has(source.plugin)) return 'metadata'
    if (source.plugin !== undefined && REAL_CONTENT_PLUGINS.has(source.plugin)) return 'real'
    // Unknown plugin names are policy rows until proven otherwise: a future
    // presence-driven injection must never silently become compressible.
    return 'instruction'
  }
  if (kind !== undefined && HOST_INSTRUCTION_KINDS.has(kind)) return 'instruction'
  // Sub-agent relay rows and any future kind: treat as real content for
  // compressibility, but they must not win "last real user message" protection
  // (see isRealUserTurn) — a relay is not the user speaking.
  return 'real'
}

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
export function isRealUserTurn(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  if (classifySurfaceEvent(event) !== 'real') return false
  const source = (event.data as { source?: { kind?: string } }).source
  // A user turn written without a source is genuine content (the host's own
  // bare-append path) and can be the protected turn.
  if (source === undefined) return true
  // Only the host's `user` kind is the human speaking. Every producer-owned
  // row — the foldable content kinds above (runtime-context snapshot,
  // ptc-mode, user-approval, model-selection, tool-registry, legacy plugin
  // names), the sub-agent relay kinds (`coordinator`, `subagent-report`,
  // `subagent-settled`, `team-message`), and ANY future kind the host adds —
  // is foldable content but never the user's words, so none of them may win
  // the protection window (issue #71's bug class). The old shape special-cased
  // the relay kinds at the tail; keying positively on `kind === 'user'`
  // subsumes that and keeps future kinds on the safe side by construction.
  return source.kind === 'user'
}
