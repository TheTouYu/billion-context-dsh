import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

/**
 * Evaluate a peer range the way the HOST does, not the way `semver` defaults.
 * dsh-app-boot admits a plugin with
 * `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`
 * (dsh-app-boot/lib/index.js), so a prerelease runtime such as `0.2.0-rc.2` —
 * the one this port targets — satisfies the range on a real host. Without the
 * option node-semver's same-tuple rule reports it unsatisfied, and this suite
 * would be asserting a rule no host applies.
 */
const satisfies = (version: string, range: string): boolean =>
	semver.satisfies(version, range, { includePrerelease: true })

// The peer contract spans FIVE seam packages the plugin VALUE-imports at
// runtime (not type-only, so they must resolve to the host's copy, not a
// stale nested copy): dsh-compaction, dsh-session, dsh-llm, dsh-tools and
// dsh-settings. The first four publish the SAME version line (in lockstep
// because DSH releases them together) and so share one range; dsh-settings
// moved into lockstep when the settings seam was folded into the host's
// profile-forms model.
//
// THE 0.2.0 PORT — the range now floors at `>=0.2.0-rc.1 <0.2.1-0`. Every
// older line (0.1.x final included) is deliberately OUT of contract because
// the seams this engine now depends on only exist on the 0.2.0 line:
//  - SETTINGS: the runtime settings integration is the host's Config-forms
//    model (`SettingsForms.describe/update/replace` + volatile `Volatile<T>`
//    refs projected from `static Config`); the 0.1.x `SettingsProvider`
//    installSection seam the old port used is gone from this source.
//  - MESSAGE SOURCES: engine-authored rows carry producer-owned kinds
//    ('acp-nudge', 'billion-context-dsh', declared in `MessageSourceMap`),
//    which the 0.1.5-line session format never admitted.
//  - TOOL/RESULT SHAPE: current events carry the id top-level
//    (`message.toolCallId`, role 'tool'); the shared extractor reads both
//    shapes but the WRITERS (compress-pair hide, prune tombstone) were
//    verified against the 0.2.0 session validator only.
//  - TOKEN ESTIMATOR: the shadow-price mirror tracks the stateVersion-5
//    estimator (image arm in `estimateStructuralBlock`, no `tool-result`
//    recursion in `estimateContent`) — matching the live meter is what makes
//    the claim exact by construction.
// Per the house rule the ceiling is explicit (`-0` suffix) so every 0.2.1
// prerelease stays rejected until a later line is verified deliberately.
// A caret floor would silently admit unverified lines — never used.
//
// The same-tuple prerelease rule still applies underneath: a candidate with a
// prerelease tag only satisfies a range when some comparator shares its
// [major, minor, patch] tuple — `0.2.0-rc.1`/`rc.2` share tuple 0.2.0, which
// is why one clause covers the whole 0.2.0 line. The host's
// `includePrerelease` option (mirrored by `satisfies` above) is what lets the
// prereleases past that rule.
//
// Versions below come from `npm view @deepseek-ai/dsh-session versions` — the
// published line matches dsh-compaction / dsh-llm / dsh-tools exactly.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
	peerDependencies: Record<string, string>
}

// The runtime VALUE-imported seam packages (matches what dist/index.js pulls
// in). cordis is also a peer but ships on a 4.x line and is NOT part of this
// seam version band, so it is excluded — these five move in lockstep with the
// DSH host.
const seamPeers = [
	'@deepseek-ai/dsh-compaction',
	'@deepseek-ai/dsh-session',
	'@deepseek-ai/dsh-llm',
	'@deepseek-ai/dsh-tools',
	'@deepseek-ai/dsh-settings',
]

for (const peerName of seamPeers) {
	const peerRange = pkg.peerDependencies[peerName]
	assert.equal(typeof peerRange, 'string', `${peerName} must be declared as a peer (runtime VALUE-import)`)

	test(`${peerName}: peer range accepts the whole 0.2.0 seam line`, () => {
		// Every published 0.2.0 version installs — rc.1 is the floor because
		// its seam shapes are identical to rc.2 (verified per
		// docs/dsh-porting-verification.md).
		for (const v of ['0.2.0-rc.1', '0.2.0-rc.2']) {
			assert.equal(
				satisfies(v, peerRange),
				true,
				`${v} must satisfy ${peerRange} (same seam shapes as the verified rc.2 baseline)`,
			)
		}
		// Future same-tuple prereleases keep installing: publishing newer rCs
		// on the 0.2.0 line never breaks installs.
		for (const v of ['0.2.0-rc.9', '0.2.0-rc.99']) {
			assert.equal(satisfies(v, peerRange), true, `${v} must satisfy ${peerRange} (same-line rc)`)
		}
		// A final 0.2.0 (no prerelease) is a normal version and stays in range.
		assert.equal(satisfies('0.2.0', peerRange), true)
	})

	test(`${peerName}: peer range keeps rejecting older and next-line versions`, () => {
		// Below the floor: every pre-0.2.0 line, including the 0.1.5/0.1.7
		// lines the earlier ports targeted. Their seams predate everything
		// listed in the header comment (settings forms, producer-owned
		// sources, the current tool/result shape, the stateVersion-5
		// estimator), so admitting them would promise a compatibility this
		// source does not have.
		for (const v of ['0.1.5-rc.1', '0.1.6', '0.1.7-rc.2', '0.1.7', '0.1.8-alpha.1']) {
			assert.equal(satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
		// Next lines: 0.2.1 and beyond stay deliberate later decisions and
		// must never be allowed silently.
		for (const v of ['0.2.1-alpha.1', '0.2.1-rc.1', '0.2.1', '0.3.0']) {
			assert.equal(satisfies(v, peerRange), false, `${v} must NOT satisfy ${peerRange}`)
		}
	})
}


test('every runtime VALUE-imported seam package is declared as a peer', () => {
	// dist/index.js must never carry a VALUE import of a @deepseek-ai seam
	// package that is NOT a peer — in a non-hoisted / stale-nested install that
	// resolves to a copy inconsistent with the host (the "reading 7" class of
	// crash). seamPeers above are the complete runtime set.
	for (const name of seamPeers) {
		assert.equal(typeof pkg.peerDependencies[name], 'string', `${name} must be a peer (runtime VALUE-import)`)
	}
})
