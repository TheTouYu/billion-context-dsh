/**
 * M6 — runtime settings integration tests (DSH 0.2.0 forms model).
 *
 * Coverage map:
 *  - pure units: schema volatile semantics (absent no-default refs read
 *    undefined, boolean defaults resolve through the ref, parse-time bounds,
 *    ordinary keys pass the loose object through), ref normalization
 *    (scalar → constant, ref → identity), snapshot resolution + equality,
 *    parseSettingValue (incl. the `false` regression), describeSettingsChange
 *    diff flags, command-surface degradation without a service;
 *  - E2E with a fake SettingsForms + LIVE refs: a profile edit hot-applies
 *    to the running engine, /acp config list/set/reset round-trips through
 *    the service (revision-guarded writes, conflict copy), reset preserves
 *    keys the schema does not know, the settingsEnabled kill switch, the
 *    late-mounted service (lazy per-call resolve);
 *  - regression locks: the composed `preset` fills unset thresholds (the
 *    schema-masking co-bug), the live autoModelContextLimit gate on the
 *    window projection, and the diff-on-read window-cache clear.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SettingsConflictError, type SettingsDescriptor, type SettingsForms } from '@deepseek-ai/dsh-settings'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session } from '@deepseek-ai/dsh-session'
import {
	ACP_SETTINGS_NAMESPACE,
	AcpSettingsSchema,
	acpSettingsEqual,
	describeSettingsChange,
	findAcpSettingsDescriptor,
	makeSettingsCommandSurface,
	normalizeSettingsRefs,
	parseSettingValue,
	resolveAcpSettings,
	SETTING_DEFAULTS,
	type SettingsKey,
} from '../src/settings.ts'
import { AcpCompactionEngine, resolveAcpConfig, type AcpPluginConfig } from '../src/index.ts'
import { kernelConfigFor } from '../src/config.ts'
import { acpCommand } from '../src/commands.ts'
import type { ToolEnvironment } from '../src/tools.ts'
import { DEFAULT_CONTEXT_WINDOW } from '../src/window.ts'

/**
 * In-memory SettingsForms fake speaking the surface the engine uses:
 * `describe()` returns one descriptor per surfaced entry (ours keyed by the
 * composition-row id), `update()` merges a patch into the USER layer,
 * `replace()` swaps it, both guarded by the descriptor revision — a write
 * against a stale revision throws the REAL SettingsConflictError, exactly
 * like the seam. Writes also re-validate the section through the schema (the
 * host re-validates at the service boundary) and then push the new values
 * into the live knob refs through `onWrite`, mirroring the host contract: a
 * profile write updates the Volatile snapshots running plugins hold.
 */
class FakeSettingsForms {
	readonly writable = true
	readonly documentPath = '/fake/profile.patch.yml'
	private revision = 7
	private readonly userLayers = new Map<string, Record<string, unknown>>()
	private readonly baseLayers = new Map<string, Record<string, unknown>>()
	/** Set to true to make the next write refuse any expectedRevision (a concurrent writer landed first). */
	conflictNext = false

	constructor(base: Record<string, unknown> = {}) {
		this.baseLayers.set(ACP_SETTINGS_NAMESPACE, { ...base })
	}

	describe(): SettingsDescriptor[] {
		return [...this.baseLayers.keys()].map((ns) => ({
			ns: ns as SettingsDescriptor['ns'],
			autoGenerate: true,
			schema: AcpSettingsSchema,
			value: { ...this.baseLayers.get(ns), ...this.userLayers.get(ns) },
			revision: this.revision,
			base: { ...this.baseLayers.get(ns) },
			user: { ...this.userLayers.get(ns) },
			applies: 'live' as const,
		}))
	}

	async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
		this.guard(ns, expectedRevision)
		const merged = { ...this.userLayers.get(ns), ...patch }
		this.validate(merged)
		this.userLayers.set(ns, merged)
		this.commit()
	}

	async replace(ns: string, section: object, expectedRevision?: number): Promise<void> {
		this.guard(ns, expectedRevision)
		this.validate(section)
		this.userLayers.set(ns, { ...section })
		this.commit()
	}

	async prepareDocument(): Promise<string> {
		return this.documentPath
	}

	/** Simulate an external profile edit (someone editing the patch on disk): new user layer, new revision. */
	externalEdit(user: Record<string, unknown>): void {
		this.userLayers.set(ACP_SETTINGS_NAMESPACE, { ...user })
		this.revision += 1
		this.notify()
	}

	onWrite?: (effective: Record<string, unknown>) => void

	private guard(ns: string, expectedRevision: number | undefined): void {
		if (this.conflictNext || (expectedRevision !== undefined && expectedRevision !== this.revision)) {
			this.conflictNext = false
			throw new SettingsConflictError(ns as never, expectedRevision ?? this.revision - 1, this.revision)
		}
	}

	private validate(section: object): void {
		// The host re-validates at the service boundary; the schema throws on
		// out-of-range values. Only the six known keys are validated — the
		// layer deliberately does not whitelist keys.
		const known: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(section)) {
			if (key === 'modelContextLimit' || key === 'autoModelContextLimit' || key.startsWith('nudge') || key === 'autoNudge') {
				known[key] = value
			}
		}
		AcpSettingsSchema(known as Record<string, never>)
	}

	private commit(): void {
		this.revision += 1
		this.notify()
	}

	/**
	 * Push the EFFECTIVE section (base layer merged under the user layer)
	 * into the live refs — what the host's Volatile references read: when the
	 * user patch drops a key, the ref falls back to the inherited base value,
	 * not to nothing.
	 */
	private notify(): void {
		const ns = ACP_SETTINGS_NAMESPACE
		this.onWrite?.({ ...this.baseLayers.get(ns), ...this.userLayers.get(ns) })
	}
}

/**
 * Live knob refs the engine is constructed with — the direct stand-in for
 * the `Volatile` references cordis parses out of `static Config`. `set`
 * simulates a profile write reaching the refs; `unset` removes the key.
 */
class LiveKnobs {
	private state: Partial<Record<SettingsKey, unknown>> = {}
	readonly modelContextLimit = { get: () => this.state.modelContextLimit as number | undefined }
	readonly autoModelContextLimit = { get: () => this.state.autoModelContextLimit as boolean | undefined }
	readonly nudgeMinContextLimitPct = { get: () => this.state.nudgeMinContextLimitPct as number | undefined }
	readonly nudgeMaxContextLimitPct = { get: () => this.state.nudgeMaxContextLimitPct as number | undefined }
	readonly nudgeEmergencyThresholdPct = { get: () => this.state.nudgeEmergencyThresholdPct as number | undefined }
	readonly autoNudge = { get: () => this.state.autoNudge as boolean | undefined }

	set(key: SettingsKey, value: number | boolean | undefined): void {
		if (value === undefined) delete this.state[key]
		else this.state[key] = value
	}

	/** Apply a written user section onto the refs (host bridge — see FakeSettingsForms.onWrite). */
	apply(section: Record<string, unknown>): void {
		for (const key of Object.keys(this.state) as SettingsKey[]) delete this.state[key]
		for (const [key, value] of Object.entries(section)) {
			if (key in this) this.set(key as SettingsKey, value as number | boolean)
		}
	}
}

/** Mount the real engine on a fresh fiber; knobs become volatile refs, everything else passes through. */
async function mountEngine(
	root: Context,
	config: AcpPluginConfig = {},
	knobs?: LiveKnobs,
): Promise<{ fiber: { dispose: () => Promise<void> }; engine: AcpCompactionEngine; knobs: LiveKnobs }> {
	const knobsRef = knobs ?? new LiveKnobs()
	let engine: AcpCompactionEngine | undefined
	const fiber = root.plugin((ctx) => {
		// With knobs the refs REPLACE the scalar form of the same keys (the
		// cordis-mounted row arrives as refs, never both); without knobs the
		// plain config exercises the scalar-construction path.
		engine = new AcpCompactionEngine(ctx, knobs === undefined ? config : { ...config, ...knobsRef })
	})
	await fiber
	if (engine === undefined) throw new Error('engine did not mount')
	return { fiber, engine, knobs: knobsRef }
}

/** Drive /acp through the real command handler (config paths never touch the agent). */
async function runAcp(env: ToolEnvironment, rawInput: string): Promise<string> {
	const command = acpCommand(env)
	const result = await command.handler({
		commandId: 'cmd-settings-test' as never,
		agent: {} as Agent,
		rawInput,
		signal: new AbortController().signal,
	} as never)
	assert.equal(result.kind, 'success')
	return (result as { text: string }).text
}

// ── Pure units ────────────────────────────────────────────────────────────

test('M6: schema volatile fields parse into live refs (no-default fields read undefined when absent)', () => {
	const parsed = AcpSettingsSchema({})
	// No-default knobs: an absent value reads `undefined` through the ref —
	// that is what lets the composed preset fill them in readSettingsSource.
	assert.equal(parsed.modelContextLimit.get(), undefined)
	assert.equal(parsed.nudgeMaxContextLimitPct.get(), undefined)
	assert.equal(parsed.nudgeMinContextLimitPct.get(), undefined)
	assert.equal(parsed.nudgeEmergencyThresholdPct.get(), undefined)
	// Boolean defaults resolve through the ref.
	assert.equal(parsed.autoModelContextLimit.get(), SETTING_DEFAULTS.autoModelContextLimit)
	assert.equal(parsed.autoNudge.get(), SETTING_DEFAULTS.autoNudge)
	// Composed values ride the ref.
	const withValues = AcpSettingsSchema({ modelContextLimit: 200000, nudgeMaxContextLimitPct: 0.6 })
	assert.equal(withValues.modelContextLimit.get(), 200000)
	assert.equal(withValues.nudgeMaxContextLimitPct.get(), 0.6)
})

test('M6: schema validates bounds at parse time and passes ordinary config through untouched', () => {
	assert.throws(() => AcpSettingsSchema({ modelContextLimit: 0 }), />= 1/)
	assert.throws(() => AcpSettingsSchema({ modelContextLimit: 128000.5 }), /multiple of 1/)
	assert.throws(() => AcpSettingsSchema({ nudgeMaxContextLimitPct: -0.1 }), />= 0/)
	assert.throws(() => AcpSettingsSchema({ nudgeEmergencyThresholdPct: 1.1 }), /<= 1/)
	assert.equal(AcpSettingsSchema({ modelContextLimit: 1, nudgeMaxContextLimitPct: 0, nudgeEmergencyThresholdPct: 1 }).modelContextLimit.get(), 1)
	// The loose object keeps unknown keys verbatim: ordinary config (preset,
	// prompts, coreOverrides, countTokens) passes `static Config` through and
	// must never surface in the generated settings form.
	const loose = AcpSettingsSchema({ preset: 'balanced', prompts: { nudge: { text: 'x' } } } as Record<string, never>)
	assert.equal((loose as Record<string, unknown>).preset, 'balanced')
	assert.equal(typeof (loose as Record<string, unknown>).prompts, 'object')
})

test('M6: normalizeSettingsRefs turns scalars into constant refs and passes refs through by identity', () => {
	const knobs = new LiveKnobs()
	const refs = normalizeSettingsRefs(knobs)
	assert.equal(refs.nudgeMaxContextLimitPct, knobs.nudgeMaxContextLimitPct, 'a live ref is kept as-is (cordis updates it)')
	const scalars = normalizeSettingsRefs({ nudgeMaxContextLimitPct: 0.6 })
	assert.equal(scalars.nudgeMaxContextLimitPct.get(), 0.6)
	assert.equal(scalars.modelContextLimit.get(), undefined)
})

test('M6: engine defaults mirror SETTING_DEFAULTS; snapshot resolution fills defaults', () => {
	const defaults = resolveAcpConfig({})
	assert.equal(defaults.autoModelContextLimit, SETTING_DEFAULTS.autoModelContextLimit)
	assert.equal(defaults.autoNudge, SETTING_DEFAULTS.autoNudge)
	assert.equal(defaults.nudgeMaxContextLimitPct, SETTING_DEFAULTS.nudgeMaxContextLimitPct)
	assert.equal(defaults.nudgeEmergencyThresholdPct, SETTING_DEFAULTS.nudgeEmergencyThresholdPct)
	assert.equal(defaults.modelContextLimit, undefined)
	assert.equal(defaults.nudgeMinContextLimitPct, undefined)
	const resolved = resolveAcpSettings({})
	assert.equal(resolved.nudgeMaxContextLimitPct, SETTING_DEFAULTS.nudgeMaxContextLimitPct)
	assert.equal(resolved.autoNudge, SETTING_DEFAULTS.autoNudge)
	assert.equal(resolved.modelContextLimit, undefined)
	assert.equal(acpSettingsEqual(resolved, resolveAcpSettings({})), true)
	assert.equal(acpSettingsEqual(resolved, resolveAcpSettings({ nudgeMaxContextLimitPct: 0.6 })), false)
})

test('M6: parseSettingValue — booleans, numbers, null; `false` is a value, not an error', () => {
	assert.deepEqual(parseSettingValue('true'), { ok: true, value: true })
	assert.deepEqual(parseSettingValue('false'), { ok: true, value: false })
	assert.deepEqual(parseSettingValue('.7'), { ok: true, value: 0.7 })
	assert.deepEqual(parseSettingValue('2e5'), { ok: true, value: 200000 })
	assert.deepEqual(parseSettingValue('200000'), { ok: true, value: 200000 })
	assert.deepEqual(parseSettingValue('null'), { ok: true, value: null })
	assert.equal(parseSettingValue('garbage').ok, false)
	assert.equal(parseSettingValue('1.5.2').ok, false)
	assert.equal(parseSettingValue('   ').ok, false)
	assert.equal(parseSettingValue('FALSE').ok, false)
})

test('M6: describeSettingsChange flags window cache, nudge dedup, and order warnings', () => {
	const base = resolveAcpSettings({})
	let effect = describeSettingsChange(base, base)
	assert.equal(effect.clearWindowCache, false)
	assert.equal(effect.clearNudgeDedup, false)
	assert.deepEqual(effect.warnings, [])
	assert.equal(describeSettingsChange(base, { ...base, modelContextLimit: 300000 }).clearWindowCache, true)
	assert.equal(describeSettingsChange(base, { ...base, autoModelContextLimit: false }).clearWindowCache, true)
	const off = { ...base, autoNudge: false }
	assert.equal(describeSettingsChange(off, base).clearNudgeDedup, true)
	assert.equal(describeSettingsChange(base, off).clearNudgeDedup, false)
	effect = describeSettingsChange(base, { ...base, nudgeMinContextLimitPct: 0.8, nudgeMaxContextLimitPct: 0.7 })
	assert.equal(effect.warnings.length, 1)
	assert.match(effect.warnings[0]!, /lower bound never engages/)
	effect = describeSettingsChange(base, { ...base, nudgeMaxContextLimitPct: 0.9 })
	assert.equal(effect.warnings.length, 1)
	assert.match(effect.warnings[0]!, /emergency tier loses its headroom/)
})

test('M6: command surface degrades without a service', async () => {
	const surface = makeSettingsCommandSurface(() => undefined, () => resolveAcpSettings({}))
	assert.equal(surface.available, false)
	assert.equal(surface.describe(), undefined)
	await assert.rejects(surface.update({ autoNudge: false }), /not available/)
})

test('M6: findAcpSettingsDescriptor matches by entry id through the brand', () => {
	const service = new FakeSettingsForms()
	const descriptor = findAcpSettingsDescriptor(service as unknown as SettingsForms)
	assert.ok(descriptor !== undefined)
	assert.equal(String(descriptor.ns), ACP_SETTINGS_NAMESPACE)
	const empty = {
		describe: () => [{ ns: 'other-entry' as never, autoGenerate: true, schema: {}, value: {}, revision: 1, applies: 'live' as const }],
	}
	assert.equal(findAcpSettingsDescriptor(empty as unknown as SettingsForms), undefined)
})

// ── E2E with a fake SettingsForms + live refs ─────────────────────────────

test('M6: a profile edit hot-applies to the running engine through the live refs', async () => {
	const root = new Context()
	const knobs = new LiveKnobs()
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		assert.equal(engine.env.modelContextLimit, DEFAULT_CONTEXT_WINDOW)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
		// The host bridge: a profile write updates the Volatile snapshots.
		knobs.set('nudgeMaxContextLimitPct', 0.6)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6, 'no flush, no restart — the read is live')
		knobs.set('nudgeMaxContextLimitPct', undefined)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
	} finally {
		await fiber.dispose()
	}
})

test('M6: /acp config list/set/reset round-trips through the service', async () => {
	const root = new Context()
	const service = new FakeSettingsForms({ nudgeMaxContextLimitPct: 0.72 })
	const knobs = new LiveKnobs()
	service.onWrite = (section) => knobs.apply(section)
	root.provide('settings', service as unknown as SettingsForms)
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		const list = await runAcp(engine.env, 'config')
		assert.match(list, /nudgeMaxContextLimitPct/)
		assert.match(list, /source/)
		assert.match(list, /nudgeMaxContextLimitPct[^\n]*base/, 'the composition layer shows as base')
		assert.match(list, /nudgeEmergencyThresholdPct[^\n]*default/)

		const setResult = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6')
		assert.match(setResult, /✓/)
		assert.equal(knobs.nudgeMaxContextLimitPct.get(), 0.6, 'the write reached the live refs')
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
		assert.equal(service.describe()[0]!.user?.nudgeMaxContextLimitPct, 0.6, 'and the user layer of the profile')

		const boolResult = await runAcp(engine.env, 'config set autoNudge false')
		assert.match(boolResult, /✓/)
		assert.equal(knobs.autoNudge.get(), false, 'boolean keys write booleans (the parse regression)')

		const resetResult = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
		assert.match(resetResult, /✓/)
		assert.match(resetResult, /0\.72/, 'reset reports the composition value it fell back to')
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.72)

		const unknown = await runAcp(engine.env, 'config set bogus 0.5')
		assert.match(unknown, /unknown key/)
		const invalid = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct bogus')
		assert.match(invalid, /not a valid value/)
		const badBool = await runAcp(engine.env, 'config set autoNudge 1')
		assert.match(badBool, /takes true or false/)
		const outOfRange = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 1.5')
		assert.match(outOfRange, /rejected/)
	} finally {
		await fiber.dispose()
	}
})

test('M6: a concurrent writer surfaces as the conflict copy, not a lost update', async () => {
	const root = new Context()
	const service = new FakeSettingsForms()
	const knobs = new LiveKnobs()
	service.onWrite = (section) => knobs.apply(section)
	root.provide('settings', service as unknown as SettingsForms)
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		service.conflictNext = true
		const result = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6')
		assert.match(result, /conflict: another writer changed this setting/)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7, 'the refused write changed nothing')
	} finally {
		await fiber.dispose()
	}
})

test('M6: reset keeps keys the six-key schema does not know (no silent data loss)', async () => {
	const root = new Context()
	const service = new FakeSettingsForms()
	const knobs = new LiveKnobs()
	service.onWrite = (section) => knobs.apply(section)
	root.provide('settings', service as unknown as SettingsForms)
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		service.externalEdit({ nudgeMaxContextLimitPct: 0.6, handWritten: 'keep-me' })
		const reset = await runAcp(engine.env, 'config reset nudgeMaxContextLimitPct')
		assert.match(reset, /✓/)
		// The service layer does not whitelist keys, so rebuilding the section
		// from SETTINGS_KEYS alone would delete the operator's own entry.
		const user = engine.env.settingsCommand.describe()?.user
		assert.equal(user?.handWritten, 'keep-me')
		assert.equal(user?.nudgeMaxContextLimitPct, undefined)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.7)
		const resetAll = await runAcp(engine.env, 'config reset all')
		assert.match(resetAll, /✓ all runtime settings reset/)
		assert.equal(engine.env.settingsCommand.describe()?.user?.handWritten, undefined)
	} finally {
		await fiber.dispose()
	}
})

test('M6: settingsEnabled false is a kill switch for /acp config — knobs stay live', async () => {
	const root = new Context()
	const service = new FakeSettingsForms({ nudgeMaxContextLimitPct: 0.4 })
	const knobs = new LiveKnobs()
	root.provide('settings', service as unknown as SettingsForms)
	const { fiber, engine } = await mountEngine(root, { settingsEnabled: false, nudgeMaxContextLimitPct: 0.66 }, knobs)
	try {
		assert.equal(engine.env.settingsCommand.available, false)
		const advice = await runAcp(engine.env, 'config set nudgeMaxContextLimitPct 0.6')
		assert.match(advice, /no settings provider/)
		// The knobs are plugin config, not service state — they stay live.
		knobs.set('nudgeMaxContextLimitPct', 0.55)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.55)
	} finally {
		await fiber.dispose()
	}
})

test('M6: the service is resolved per call — a late-mounted service appears, disposal disappears', async () => {
	const root = new Context()
	const knobs = new LiveKnobs()
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		assert.equal(engine.env.settingsCommand.available, false)
		const service = new FakeSettingsForms()
		const serviceFiber = await root.plugin((ctx) => {
			ctx.provide('settings', service as unknown as SettingsForms)
		})
		assert.equal(engine.env.settingsCommand.available, true, 'no captured handle — the next call sees it')
		await serviceFiber.dispose()
		assert.equal(engine.env.settingsCommand.available, false, 'an unloaded service degrades instead of writing into a disposed one')
	} finally {
		await fiber.dispose()
	}
})

test('M6: a service without our entry degrades with guidance', async () => {
	const root = new Context()
	const knobs = new LiveKnobs()
	root.provide('settings', {
		describe: () => [{ ns: 'other-entry' as never, autoGenerate: true, schema: {}, value: {}, revision: 1, applies: 'live' as const }],
	} as unknown as SettingsForms)
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		assert.equal(engine.env.settingsCommand.available, false)
		await assert.rejects(engine.env.settingsCommand.update({ autoNudge: false }), /no settings entry "compaction-acp"/)
	} finally {
		await fiber.dispose()
	}
})

// ── Regression locks ──────────────────────────────────────────────────────

test('M6: the composed preset fills thresholds nobody set (explicit value > preset > default)', async () => {
	const root = new Context()
	const knobs = new LiveKnobs()
	// The schema carries NO default on the thresholds precisely so this fill
	// works: a schema default would mask the preset exactly the way
	// DEFAULT_CONFIG once did (the co-bug this locks).
	const { fiber, engine } = await mountEngine(root, { preset: 'efficient' }, knobs)
	try {
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6, 'efficient preset threshold')
		assert.equal(engine.env.nudgeMinContextLimitPct, 0.4)
		assert.equal(engine.env.nudgeEmergencyThresholdPct, 0.78)
		// An explicit live value wins over the preset.
		knobs.set('nudgeMaxContextLimitPct', 0.5)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.5)
		assert.equal(engine.env.nudgeMinContextLimitPct, 0.4, 'untouched keys keep the preset fill')
		// Unsetting falls BACK to the preset, not the bare default.
		knobs.set('nudgeMaxContextLimitPct', undefined)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.6)
		// The preset reaches the kernel config through the same read.
		assert.equal(kernelConfigFor(engine.env).nudge.maxContextLimitPct, 0.6)
	} finally {
		await fiber.dispose()
	}
})

test('M6: a live autoModelContextLimit false gates the window projection (B1 lock, new seam)', async () => {
	const root = new Context()
	const knobs = new LiveKnobs()
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		const ctx = new Context()
		ctx.provide('sessionProjections', {
			snapshot: () => ({ values: { contextPressure: { contextWindow: 1000000 } } }),
		})
		ctx.provide('llm', {
			resolveModelInfo: async () => ({ context: { contextWindow: 64000 } }),
		})
		const agent = {
			id: 'test-session',
			session: Session.create('test-session'),
			options: { provider: 'test-provider', model: 'test-model' },
			ctx,
		} as unknown as Agent
		// Reading a construction-time snapshot at the gate would keep
		// consulting the projection after the user disabled auto detection.
		assert.equal((await engine.windowFor(agent)).source, 'projection')
		knobs.set('autoModelContextLimit', false)
		assert.notEqual((await engine.windowFor(agent)).source, 'projection')
		assert.equal((await engine.windowFor(agent)).source, 'default')
		knobs.set('modelContextLimit', 200000)
		assert.equal((await engine.windowFor(agent)).source, 'explicit')
	} finally {
		await fiber.dispose()
	}
})

test('M6: a knob change clears the per-route window cache on the next read (diff-on-read)', async () => {
	const root = new Context()
	const knobs = new LiveKnobs()
	const { fiber, engine } = await mountEngine(root, {}, knobs)
	try {
		// A probe whose answer changes per call: the second probe returns a
		// different window, so a STALE cache would still show the first one.
		let probeCount = 0
		const ctx = new Context()
		ctx.provide('llm', {
			resolveModelInfo: async () => ({ context: { contextWindow: probeCount === 0 ? 64000 : 96000 } }),
		})
		const agent = {
			id: 'probe-session',
			session: Session.create('probe-session'),
			options: { provider: 'probe-provider', model: 'probe-model' },
			ctx,
		} as unknown as Agent
		// First probe answers 64000 and lands in the per-route cache.
		assert.equal((await engine.windowFor(agent)).limit, 64000)
		// Flip a window-related knob and flip it back: the diff-on-read in
		// readSettingsSource clears the cache between the two probe reads.
		knobs.set('modelContextLimit', 200000)
		assert.equal((await engine.windowFor(agent)).source, 'explicit')
		knobs.set('modelContextLimit', undefined)
		probeCount += 1 // the next probe now answers 96000
		const reprobe = await engine.windowFor(agent)
		assert.equal(reprobe.source, 'auto')
		assert.equal(reprobe.limit, 96000, 'the cache was cleared — the fresh probe answer wins')
	} finally {
		await fiber.dispose()
	}
})

test('M6: scalar knobs flatten into ordinary config at construction (refs never leak into AcpConfig)', async () => {
	const root = new Context()
	const { fiber, engine } = await mountEngine(root, { nudgeMaxContextLimitPct: 0.66, modelContextLimit: 123456 })
	try {
		assert.equal(engine.config.nudgeMaxContextLimitPct, 0.66)
		assert.equal(engine.config.modelContextLimit, 123456)
		assert.equal(engine.env.nudgeMaxContextLimitPct, 0.66)
		assert.equal(engine.env.modelContextLimit, 123456)
	} finally {
		await fiber.dispose()
	}
})
