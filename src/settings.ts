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

import z from '@deepseek-ai/schemastery'
import { SettingsConflictError, type SettingsDescriptor, type SettingsForms } from '@deepseek-ai/dsh-settings'

/**
 * The settings entry id — the composition row id of the engine's plugin
 * entry. The bundle patch and the README's manual rows both use
 * `compaction-acp`, and the same-id override contract (write your own
 * `compaction-acp` row to customize) keeps every composition speaking one
 * id. `SettingsForms.describe()` keys its forms by exactly this entry id,
 * and a pre-0.2 `settings.yaml` section of the same name is imported into
 * the entry on first boot.
 */
export const ACP_SETTINGS_NAMESPACE = 'compaction-acp'

/** The six knobs exposed to the runtime settings layer. Order defines /acp config listing order. */
export const SETTINGS_KEYS = [
  'modelContextLimit',
  'autoModelContextLimit',
  'nudgeMinContextLimitPct',
  'nudgeMaxContextLimitPct',
  'nudgeEmergencyThresholdPct',
  'autoNudge',
] as const

export type SettingsKey = (typeof SETTINGS_KEYS)[number]

/** Resolved shape of one settings snapshot — what every consumer read returns. */
export interface AcpSettings {
  /** Absent = auto-detection mode (probe the model's real window). */
  readonly modelContextLimit?: number
  readonly autoModelContextLimit: boolean
  /** Absent = the kernel's own 0.45 floor stays in effect. */
  readonly nudgeMinContextLimitPct?: number
  readonly nudgeMaxContextLimitPct: number
  readonly nudgeEmergencyThresholdPct: number
  readonly autoNudge: boolean
}

/** Input shape (everything optional — omitted keys fall back to defaults). */
export type AcpSettingsInput = Partial<AcpSettings>

/**
 * Engine defaults for the settings-exposed keys — the resolution defaults
 * `resolveAcpSettings` fills for absent keys (and the schema `.default()` for
 * the two booleans). Deliberately below the kernel/billion-context-pi
 * 0.75/0.95 so the forced nudge fires ahead of the host's 80% auto-compaction
 * line. `AcpSettingsSchema` builds its two boolean defaults FROM this object,
 * so the schema and the resolution path can never drift apart.
 */
export const SETTING_DEFAULTS = {
  autoModelContextLimit: true,
  nudgeMaxContextLimitPct: 0.7,
  nudgeEmergencyThresholdPct: 0.85,
  autoNudge: true,
} as const

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
export const AcpSettingsSchema = z.object({
  modelContextLimit: z.number().step(1).min(1).volatile(),
  autoModelContextLimit: z.boolean().default(SETTING_DEFAULTS.autoModelContextLimit).volatile(),
  nudgeMinContextLimitPct: z.number().min(0).max(1).volatile(),
  nudgeMaxContextLimitPct: z.number().min(0).max(1).volatile(),
  nudgeEmergencyThresholdPct: z.number().min(0).max(1).volatile(),
  autoNudge: z.boolean().default(SETTING_DEFAULTS.autoNudge).volatile(),
})

/**
 * A live handle for one settings knob. Cordis hands the constructor
 * `Volatile<T>` references for the schema's volatile fields; anything shaped
 * like `{ get() }` works, which keeps the engine free of a runtime import
 * from cosmokit (the structural read is all it needs).
 */
export interface SettingsRef<T> {
  get(): T | undefined
}

/** One knob as the CONSTRUCTOR accepts it: a live ref (cordis-parsed row) or a plain scalar (tests, fakes). */
export type SettingsInput<T> = SettingsRef<T | undefined> | T | undefined

/** The six knobs as live handles — what the engine keeps and reads on every use. */
export interface AcpSettingsRefs {
  readonly modelContextLimit: SettingsRef<number | undefined>
  readonly autoModelContextLimit: SettingsRef<boolean | undefined>
  readonly nudgeMinContextLimitPct: SettingsRef<number | undefined>
  readonly nudgeMaxContextLimitPct: SettingsRef<number | undefined>
  readonly nudgeEmergencyThresholdPct: SettingsRef<number | undefined>
  readonly autoNudge: SettingsRef<boolean | undefined>
}

/** The six knobs in their constructor-input form (ref-or-scalar, all optional). */
export interface AcpSettingsInputs {
  readonly modelContextLimit?: SettingsInput<number>
  readonly autoModelContextLimit?: SettingsInput<boolean>
  readonly nudgeMinContextLimitPct?: SettingsInput<number>
  readonly nudgeMaxContextLimitPct?: SettingsInput<number>
  readonly nudgeEmergencyThresholdPct?: SettingsInput<number>
  readonly autoNudge?: SettingsInput<boolean>
}

/** True when the value already looks like a live ref (has a callable `get`). */
function isRef<T>(value: SettingsInput<T>): value is SettingsRef<T | undefined> {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Normalize the constructor's knob inputs into live refs. A ref passes
 * through untouched (cordis updates its snapshot on every profile write); a
 * scalar becomes a CONSTANT ref, so direct construction (tests, fakes) and
 * cordis-mounted rows share one live-read path and one precedence chain.
 */
export function normalizeSettingsRefs(inputs: AcpSettingsInputs): AcpSettingsRefs {
  const one = <T>(value: SettingsInput<T>): SettingsRef<T | undefined> =>
    isRef(value) ? value : { get: () => value }
  return {
    modelContextLimit: one(inputs.modelContextLimit),
    autoModelContextLimit: one(inputs.autoModelContextLimit),
    nudgeMinContextLimitPct: one(inputs.nudgeMinContextLimitPct),
    nudgeMaxContextLimitPct: one(inputs.nudgeMaxContextLimitPct),
    nudgeEmergencyThresholdPct: one(inputs.nudgeEmergencyThresholdPct),
    autoNudge: one(inputs.autoNudge),
  }
}

/** Read every knob once — the construction-time scalar snapshot of the live refs. */
export function readSettingsRefs(refs: AcpSettingsRefs): AcpSettingsInput {
  return {
    modelContextLimit: refs.modelContextLimit.get(),
    autoModelContextLimit: refs.autoModelContextLimit.get(),
    nudgeMinContextLimitPct: refs.nudgeMinContextLimitPct.get(),
    nudgeMaxContextLimitPct: refs.nudgeMaxContextLimitPct.get(),
    nudgeEmergencyThresholdPct: refs.nudgeEmergencyThresholdPct.get(),
    autoNudge: refs.autoNudge.get(),
  }
}

/** Shallow snapshot equality — the diff-on-read guard so unchanged reads fire no change effects. */
export function acpSettingsEqual(a: AcpSettings, b: AcpSettings): boolean {
  return a.modelContextLimit === b.modelContextLimit
    && a.autoModelContextLimit === b.autoModelContextLimit
    && a.nudgeMinContextLimitPct === b.nudgeMinContextLimitPct
    && a.nudgeMaxContextLimitPct === b.nudgeMaxContextLimitPct
    && a.nudgeEmergencyThresholdPct === b.nudgeEmergencyThresholdPct
    && a.autoNudge === b.autoNudge
}

/**
 * Fill an optional snapshot with the defaults. Still the one resolution path
 * even though the schema now carries `.default()` on two of the volatile
 * fields: `Volatile.get()` without a schema default (modelContextLimit, the
 * three nudge thresholds) yields `undefined`, tests build partials, and the
 * command-surface fakes feed raw sections — every caller resolves through
 * here so the schema defaults and this object can never disagree.
 */
export function resolveAcpSettings(input: AcpSettingsInput): AcpSettings {
  return {
    modelContextLimit: input.modelContextLimit,
    autoModelContextLimit: input.autoModelContextLimit ?? SETTING_DEFAULTS.autoModelContextLimit,
    nudgeMinContextLimitPct: input.nudgeMinContextLimitPct,
    nudgeMaxContextLimitPct: input.nudgeMaxContextLimitPct ?? SETTING_DEFAULTS.nudgeMaxContextLimitPct,
    nudgeEmergencyThresholdPct: input.nudgeEmergencyThresholdPct ?? SETTING_DEFAULTS.nudgeEmergencyThresholdPct,
    autoNudge: input.autoNudge ?? SETTING_DEFAULTS.autoNudge,
  }
}

/** What changed between two settings snapshots, and what the engine must do about it. */
export interface SettingsChangeEffect {
  /**
   * The per-route window cache (which also caches probe FAILURES) must be
   * dropped so the next step re-resolves windows under the new limits.
   */
  clearWindowCache: boolean
  /**
   * Re-enabling nudges clears the per-turn dedup map: entries written while
   * nudging was off must not suppress the first fresh nudge.
   */
  clearNudgeDedup: boolean
  /** Human-readable order-anomaly warnings. Accepted, not rejected — a rejected write cannot fix an externally-edited file anyway. */
  readonly warnings: readonly string[]
}

/** Pure diff used by the engine's change handler (unit-testable without a context). */
export function describeSettingsChange(prev: AcpSettings, next: AcpSettings): SettingsChangeEffect {
  const warnings: string[] = []
  // An anomaly warning is about the NEW state alone — it must not depend on
  // what the previous snapshot happened to define.
  if (
    next.nudgeMinContextLimitPct !== undefined
    && next.nudgeMinContextLimitPct >= next.nudgeMaxContextLimitPct
  ) {
    warnings.push(
      `nudgeMinContextLimitPct (${next.nudgeMinContextLimitPct}) >= nudgeMaxContextLimitPct (${next.nudgeMaxContextLimitPct}) — the lower bound never engages`,
    )
  }
  if (next.nudgeMaxContextLimitPct >= next.nudgeEmergencyThresholdPct) {
    warnings.push(
      `nudgeMaxContextLimitPct (${next.nudgeMaxContextLimitPct}) >= nudgeEmergencyThresholdPct (${next.nudgeEmergencyThresholdPct}) — the emergency tier loses its headroom`,
    )
  }
  return {
    clearWindowCache: prev.modelContextLimit !== next.modelContextLimit
      || prev.autoModelContextLimit !== next.autoModelContextLimit,
    clearNudgeDedup: prev.autoNudge === false && next.autoNudge === true,
    warnings,
  }
}

/** Result of parsing a `/acp config set` value. `null` means "reset this key". */
export type ParsedSettingValue =
  | { ok: true; value: number | boolean | null }
  | { ok: false; reason: string }

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
export function parseSettingValue(raw: string): ParsedSettingValue {
  const text = raw.trim()
  if (text === 'true') return { ok: true, value: true }
  if (text === 'false') return { ok: true, value: false }
  const num = Number(text)
  if (text !== '' && Number.isFinite(num)) return { ok: true, value: num }
  if (text === 'null') return { ok: true, value: null }
  return {
    ok: false,
    reason: `"${text}" is not a valid value — use a number (0.65), true/false, or null to reset the key`,
  }
}

/** Everything `/acp config` needs from the engine. Fakes in tests implement this directly. */
export interface SettingsCommandSurface {
  /** False in processes without a settings service (plain npm-install compositions): the command degrades to advice instead of failing. */
  readonly available: boolean
  /** Current effective values (works with or without a service). */
  snapshot(): AcpSettings
  /** Our entry's form descriptor (layers + revision), or undefined while the entry is not surfaced. */
  describe(): SettingsDescriptor | undefined
  /** Merge a patch into the entry's profile override and persist it. */
  update(patch: AcpSettingsInput): Promise<void>
  /** Replace the whole volatile override ({} resets every knob to base/defaults). */
  replaceSection(section: Record<string, unknown>): Promise<void>
}

/**
 * Read our entry's form descriptor off a settings service. `descriptor.ns`
 * carries the seam's compile-time brand, which a plain literal never
 * satisfies — compare through String() instead.
 */
export function findAcpSettingsDescriptor(service: SettingsForms): SettingsDescriptor | undefined {
  return service.describe().find((descriptor) => String(descriptor.ns) === ACP_SETTINGS_NAMESPACE)
}

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
export function makeSettingsCommandSurface(
  getService: () => SettingsForms | undefined,
  getSnapshot: () => AcpSettings,
): SettingsCommandSurface {
  const requireDescriptor = (service: SettingsForms): { descriptor: SettingsDescriptor } => {
    const descriptor = findAcpSettingsDescriptor(service)
    if (descriptor === undefined) {
      throw new Error(
        `no settings entry "${ACP_SETTINGS_NAMESPACE}" — the engine must be mounted under a composition row with that id for /acp config to reach it`,
      )
    }
    return { descriptor }
  }
  return {
    get available() {
      const service = getService()
      return service !== undefined && findAcpSettingsDescriptor(service) !== undefined
    },
    snapshot: getSnapshot,
    describe() {
      const service = getService()
      if (service === undefined) return undefined
      return findAcpSettingsDescriptor(service)
    },
    async update(patch) {
      const service = getService()
      if (service === undefined) throw new Error('runtime settings are not available in this process')
      const { descriptor } = requireDescriptor(service)
      await service.update(ACP_SETTINGS_NAMESPACE, patch, descriptor.revision)
    },
    async replaceSection(section) {
      const service = getService()
      if (service === undefined) throw new Error('runtime settings are not available in this process')
      const { descriptor } = requireDescriptor(service)
      await service.replace(ACP_SETTINGS_NAMESPACE, section, descriptor.revision)
    },
  }
}

export { SettingsConflictError }
