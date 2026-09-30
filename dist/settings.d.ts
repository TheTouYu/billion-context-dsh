/**
 * M6 — runtime settings integration on the DSH 0.2.0 settings model.
 *
 * The 0.1.x seam (`SettingsProvider.installSection`, `~/.dsh/settings.yaml`
 * sections) is gone. The 0.2.0 host projects settings from PLUGIN CONFIG
 * SCHEMAS: a plugin declares `static Config` with `volatile()` fields, the
 * active profile's entry carries the values, and `ctx.settings`
 * (`SettingsForms`) surfaces them as live-editable forms (edits land in the
 * profile patch — the old `settings.yaml` sections are imported once on
 * first boot by the host itself, so a pre-0.2 `compaction-acp:` section
 * migrates automatically into the `compaction-acp` entry).
 *
 * This module therefore owns three things:
 *  1. `AcpSettingsSchema` — the volatile subset of the engine's Config
 *     (the six scalar knobs). Referenced by `AcpCompactionEngine.static
 *     Config`; `volatileForm` in the host picks up exactly these fields, so
 *     the generated settings page and `/acp config` show the same surface.
 *     Ordinary config (prompts, coreOverrides, countTokens, the auto*
 *     registration switches) is deliberately NOT in the schema: it is not
 *     hot-editable and must never appear in the form.
 *  2. The resolved-snapshot helpers (`resolveAcpSettings`,
 *     `describeSettingsChange`) — unchanged pure units from the 0.1.x line.
 *  3. `makeSettingsCommandSurface` — the `/acp config` read/write surface
 *     over `ctx.settings.describe()/update()/replace()`.
 *
 * Layering per key (what `/acp config list` reports as the source): schema
 * default → inherited composition layers (the form's `base`) → the active
 * profile's own override for the `compaction-acp` entry (the form's `user`).
 * A volatile change applies to RUNNING sessions without a plugin remount —
 * the engine reads the knobs through the live `Volatile` references, never
 * through a construction-time snapshot.
 * @module billion-context-dsh/settings
 */
import z from '@deepseek-ai/schemastery';
import { SettingsConflictError, type SettingsDescriptor, type SettingsForms } from '@deepseek-ai/dsh-settings';
/**
 * The settings entry id — the composition row id of the engine's plugin
 * entry. The bundle patch and the README's manual rows both use
 * `compaction-acp`, and the same-id override contract (write your own
 * `compaction-acp` row to customize) keeps every composition speaking one
 * id. `SettingsForms.describe()` keys its forms by exactly this entry id,
 * and a pre-0.2 `settings.yaml` section of the same name is imported into
 * the entry on first boot.
 */
export declare const ACP_SETTINGS_NAMESPACE = "compaction-acp";
/** The six knobs exposed to the runtime settings layer. Order defines /acp config listing order. */
export declare const SETTINGS_KEYS: readonly ['modelContextLimit', 'autoModelContextLimit', 'nudgeMinContextLimitPct', 'nudgeMaxContextLimitPct', 'nudgeEmergencyThresholdPct', 'autoNudge'];
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
/** Resolved shape of one settings snapshot — what every consumer read returns. */
export interface AcpSettings {
    /** Absent = auto-detection mode (probe the model's real window). */
    readonly modelContextLimit?: number;
    readonly autoModelContextLimit: boolean;
    /** Absent = the kernel's own 0.45 floor stays in effect. */
    readonly nudgeMinContextLimitPct?: number;
    readonly nudgeMaxContextLimitPct: number;
    readonly nudgeEmergencyThresholdPct: number;
    readonly autoNudge: boolean;
}
/** Input shape (everything optional — omitted keys fall back to defaults). */
export type AcpSettingsInput = Partial<AcpSettings>;
/**
 * Engine defaults for the settings-exposed keys — the resolution defaults
 * `resolveAcpSettings` fills for absent keys (and the schema `.default()` for
 * the two booleans). Deliberately below the kernel/billion-context-pi
 * 0.75/0.95 so the forced nudge fires ahead of the host's 80% auto-compaction
 * line. `AcpSettingsSchema` builds its two boolean defaults FROM this object,
 * so the schema and the resolution path can never drift apart.
 */
export declare const SETTING_DEFAULTS: {
    readonly autoModelContextLimit: true;
    readonly nudgeMaxContextLimitPct: 0.7;
    readonly nudgeEmergencyThresholdPct: 0.85;
    readonly autoNudge: true;
};
/**
 * The settings schema: the VOLATILE subset of the engine's plugin Config.
 * Referenced by `AcpCompactionEngine.static Config` — one schema object, so
 * the profile validator, the generated settings page, and `/acp config`
 * always agree on the field set.
 *
 * Integer constraint uses `.step(1).min(1)` because schemastery 3.18.x has no
 * `.int()`/`.positive()` helpers. Parsing yields `Volatile<T>` references for
 * every field (present or absent), which the engine keeps and reads live.
 *
 * Only the two booleans carry `.default()`: their refs then resolve `true`
 * when nobody composed a value, and the settings form shows the effective
 * value. The THREE NUDGE THRESHOLDS deliberately carry NO schema default —
 * an absent ref must read `undefined` so `readSettingsSource` can let the
 * composed `preset` tier fill it (explicit value > preset > engine default);
 * a schema default would mask the preset exactly the way `DEFAULT_CONFIG`
 * once did (see `resolvePresetThresholds`), and the form control showing
 * empty for an unset threshold is the honest display of "inherited".
 */
export declare const AcpSettingsSchema: z<Schemastery.ObjectS<NoInfer<{
    modelContextLimit: z<number, number, "volatile">;
    autoModelContextLimit: z<boolean, boolean, "volatile-defined">;
    nudgeMinContextLimitPct: z<number, number, "volatile">;
    nudgeMaxContextLimitPct: z<number, number, "volatile">;
    nudgeEmergencyThresholdPct: z<number, number, "volatile">;
    autoNudge: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    modelContextLimit: z<number, number, "volatile">;
    autoModelContextLimit: z<boolean, boolean, "volatile-defined">;
    nudgeMinContextLimitPct: z<number, number, "volatile">;
    nudgeMaxContextLimitPct: z<number, number, "volatile">;
    nudgeEmergencyThresholdPct: z<number, number, "volatile">;
    autoNudge: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
/**
 * A live handle for one settings knob. Cordis hands the constructor
 * `Volatile<T>` references for the schema's volatile fields; anything shaped
 * like `{ get() }` works, which keeps the engine free of a runtime import
 * from cosmokit (the structural read is all it needs).
 */
export interface SettingsRef<T> {
    get(): T | undefined;
}
/** One knob as the CONSTRUCTOR accepts it: a live ref (cordis-parsed row) or a plain scalar (tests, fakes). */
export type SettingsInput<T> = SettingsRef<T | undefined> | T | undefined;
/** The six knobs as live handles — what the engine keeps and reads on every use. */
export interface AcpSettingsRefs {
    readonly modelContextLimit: SettingsRef<number | undefined>;
    readonly autoModelContextLimit: SettingsRef<boolean | undefined>;
    readonly nudgeMinContextLimitPct: SettingsRef<number | undefined>;
    readonly nudgeMaxContextLimitPct: SettingsRef<number | undefined>;
    readonly nudgeEmergencyThresholdPct: SettingsRef<number | undefined>;
    readonly autoNudge: SettingsRef<boolean | undefined>;
}
/** The six knobs in their constructor-input form (ref-or-scalar, all optional). */
export interface AcpSettingsInputs {
    readonly modelContextLimit?: SettingsInput<number>;
    readonly autoModelContextLimit?: SettingsInput<boolean>;
    readonly nudgeMinContextLimitPct?: SettingsInput<number>;
    readonly nudgeMaxContextLimitPct?: SettingsInput<number>;
    readonly nudgeEmergencyThresholdPct?: SettingsInput<number>;
    readonly autoNudge?: SettingsInput<boolean>;
}
/**
 * Normalize the constructor's knob inputs into live refs. A ref passes
 * through untouched (cordis updates its snapshot on every profile write); a
 * scalar becomes a CONSTANT ref, so direct construction (tests, fakes) and
 * cordis-mounted rows share one live-read path and one precedence chain.
 */
export declare function normalizeSettingsRefs(inputs: AcpSettingsInputs): AcpSettingsRefs;
/** Read every knob once — the construction-time scalar snapshot of the live refs. */
export declare function readSettingsRefs(refs: AcpSettingsRefs): AcpSettingsInput;
/** Shallow snapshot equality — the diff-on-read guard so unchanged reads fire no change effects. */
export declare function acpSettingsEqual(a: AcpSettings, b: AcpSettings): boolean;
/**
 * Fill an optional snapshot with the defaults. Still the one resolution path
 * even though the schema now carries `.default()` on two of the volatile
 * fields: `Volatile.get()` without a schema default (modelContextLimit, the
 * three nudge thresholds) yields `undefined`, tests build partials, and the
 * command-surface fakes feed raw sections — every caller resolves through
 * here so the schema defaults and this object can never disagree.
 */
export declare function resolveAcpSettings(input: AcpSettingsInput): AcpSettings;
/** What changed between two settings snapshots, and what the engine must do about it. */
export interface SettingsChangeEffect {
    /**
     * The per-route window cache (which also caches probe FAILURES) must be
     * dropped so the next step re-resolves windows under the new limits.
     */
    clearWindowCache: boolean;
    /**
     * Re-enabling nudges clears the per-turn dedup map: entries written while
     * nudging was off must not suppress the first fresh nudge.
     */
    clearNudgeDedup: boolean;
    /** Human-readable order-anomaly warnings. Accepted, not rejected — a rejected write cannot fix an externally-edited file anyway. */
    readonly warnings: readonly string[];
}
/** Pure diff used by the engine's change handler (unit-testable without a context). */
export declare function describeSettingsChange(prev: AcpSettings, next: AcpSettings): SettingsChangeEffect;
/** Result of parsing a `/acp config set` value. `null` means "reset this key". */
export type ParsedSettingValue = {
    ok: true;
    value: number | boolean | null;
} | {
    ok: false;
    reason: string;
};
/**
 * Four-step value parser for `/acp config set` — deliberately NOT bare
 * JSON.parse, which rejects the most common human inputs (`.7` throws a
 * SyntaxError and the raw string would then fail schema validation; `null`
 * would silently mean "unset" only by convention). Order:
 * 1. `true` / `false` literals → booleans;
 * 2. anything Number() accepts finitely (`.7`, `2e5`, `200000`) → number;
 * 3. `null` (word) → reset-this-key sentinel;
 * 4. otherwise rejected with guidance.
 */
export declare function parseSettingValue(raw: string): ParsedSettingValue;
/** Everything `/acp config` needs from the engine. Fakes in tests implement this directly. */
export interface SettingsCommandSurface {
    /** False in processes without a settings service (plain npm-install compositions): the command degrades to advice instead of failing. */
    readonly available: boolean;
    /** Current effective values (works with or without a service). */
    snapshot(): AcpSettings;
    /** Our entry's form descriptor (layers + revision), or undefined while the entry is not surfaced. */
    describe(): SettingsDescriptor | undefined;
    /** Merge a patch into the entry's profile override and persist it. */
    update(patch: AcpSettingsInput): Promise<void>;
    /** Replace the whole volatile override ({} resets every knob to base/defaults). */
    replaceSection(section: Record<string, unknown>): Promise<void>;
}
/**
 * Read our entry's form descriptor off a settings service. `descriptor.ns`
 * carries the seam's compile-time brand, which a plain literal never
 * satisfies — compare through String() instead.
 */
export declare function findAcpSettingsDescriptor(service: SettingsForms): SettingsDescriptor | undefined;
/**
 * Build the command surface over a lazily-resolved settings service. The
 * engine resolves `ctx.get('settings')` on every CALL (no captured handle),
 * so a service that unloads mid-process degrades to advice instead of
 * writing into a disposed service — the 0.1.x attach/detach dance is
 * unnecessary against this seam.
 *
 * Writes are OPTIMISTICLY CONCURRENT: every write first describes the entry
 * and passes the observed `revision` to the seam, so a change that landed
 * between our read and our write surfaces as `SettingsConflictError`
 * ("another writer changed this setting") instead of a silent lost update.
 */
export declare function makeSettingsCommandSurface(getService: () => SettingsForms | undefined, getSnapshot: () => AcpSettings): SettingsCommandSurface;
export { SettingsConflictError };
