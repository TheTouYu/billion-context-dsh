/**
 * Host-vocabulary token pricing for the durable shadow-price protocol.
 *
 * The host token-meter prices every appended message with a fixed flat-4
 * heuristic (`estimateContent` / `estimateMessage` in `dsh-token-meter`) and
 * the producer contract requires every `compaction/summary`/`compaction/prune`
 * `shadowedTokenCount` claim to be derived from the SAME estimator. Writing
 * claims with the engine's CJK-aware `defaultCountTokens` overdraws the meter
 * on CJK-heavy sessions and permanently bricks them (live session
 * `session-3aa366c3`, issue #54; AGENTS.md rule 12 — `defaultCountTokens` is
 * display currency, NEVER event currency).
 *
 * This module prices claims in the host's vocabulary: it prefers the live
 * meter's own per-node FIXED-HEURISTIC prices (`ctx.tokenMeter.measure(session)`
 * nodes' `heuristicTokens` — the same basis the projection ledger accumulates
 * appends with, so the claim is exact by construction) and falls back to an
 * exact mirror of the host's estimator when the meter is unreachable.
 *
 * Two vocabularies share the meter's node since DSH 0.1.2: `tokens` carries
 * the measured route's request pressure (image occurrences re-priced with the
 * route's declared visual tokens) while `heuristicTokens` keeps the fixed
 * flat-4 heuristic the ledger prices appends with. The claim MUST read
 * `heuristicTokens`: a routed `tokens` claim overstates the replaced range
 * against its own ledger accumulation and folds `messageTokens` negative —
 * the same session-bricking schema rejection as #54, through the image-route
 * channel (issue #103). Older hosts (0.1.0/0.1.1 lines) expose a single
 * `tokens` field that IS the fixed heuristic, so the fallback reads it.
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** The host's model-visible content block union (structural, mirror-side only). */
export type HostBlock = {
    type: 'text';
    text: string;
} | {
    type: 'reasoning';
    text: string;
} | {
    type: 'tool-call';
    name: string;
    arguments: string;
} | {
    type: 'tool-result';
    toolCallId: string;
    content: readonly HostBlock[] | string;
} | ({
    type?: string;
} & Record<string, unknown>);
/**
 * Exact mirror of the host's `estimateContent`
 * (`@deepseek-ai/dsh-token-meter/lib/types/estimate.js`, 0.2.0 estimator):
 * text/reasoning `ceil(len/4)+4`, tool-call `ceil(name/4)+ceil(arguments/4)+4`,
 * and EVERY other block — including `tool-result` and image references —
 * through the structural arm above. The 0.1.5 estimator recursed into
 * `tool-result` content; that arm is GONE on this line (stateVersion 5), so a
 * legacy nested `tool-result` block (0.1.5/0.1.7 logs) prices as
 * `4+ceil(JSON.stringify(whole block)/4)` — which is also what the LIVE meter
 * does when it re-prices those rows, so the mirror stays exact against the
 * same claim basis.
 */
export declare function estimateHostContent(blocks: readonly HostBlock[]): number;
/** Exact mirror of the host's `estimateMessage` (content + role framing). */
export declare function estimateHostMessage(message: {
    content: readonly HostBlock[];
}): number;
/**
 * Host price of ONE session event under the mirror: project it through the
 * host's `deriveEventMessage` (null for non-surface events and empty-content
 * assistant messages) and price the derived message; null derives to 0.
 */
export declare function hostPriceEvent(event: SessionEvent): number;
/** Mirror price of a set of surface seqs (the fallback claim computation). */
export declare function shadowedHostTokens(session: Session, seqs: readonly number[]): number;
/**
 * Claim price for `seqs` in the host's vocabulary. Prefers the live meter's
 * own per-node FIXED-HEURISTIC prices when `ctx.tokenMeter` is reachable and
 * covers every shadowed seq (exact by construction — the ledger's
 * `foldSurfaceProjection` accumulates appends with the same fixed heuristic,
 * so the claim and the ledger stay in agreement; follows host estimator
 * changes automatically). `node.heuristicTokens` is that basis since DSH 0.1.2;
 * `node.tokens` there is the measured route's REQUEST pressure (image
 * occurrences carry the route's visual price via `priceSurface`) and MUST NOT
 * be claimed — reading it overstates the claim and folds the host projection
 * negative on image-containing ranges (issue #103, the image-route channel of
 * the #54 brick). Older meters expose a single `tokens` field that IS the
 * fixed heuristic, so `heuristicTokens ?? tokens` covers both shapes. ANY
 * failure — meter absent, `measure` throwing (e.g. a step-less log), or a seq
 * missing from the measurement — falls back to the exact mirror. Never returns
 * a `defaultCountTokens` price (rule 12).
 */
export declare function shadowedTokensViaMeter(session: Session, seqs: readonly number[], ctx?: {
    get?(name: string): unknown;
} | null): number;
