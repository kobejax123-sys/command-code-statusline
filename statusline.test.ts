// Tests for the context-window lookup table.
//
// WINDOW_RULES is the mod's only source for a model's context window, and it is
// correct only because of its ordering, so the cases below are checked against
// the values the CLI publishes — never against the table itself.
//
//   npm test
//
// Requires Node >= 22.18 (type stripping) and needs no dependencies.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_WINDOW, WINDOW_RULES, windowFor} from './statusline.ts';

/**
 * Every model id the CLI lists, with the context window it publishes for it.
 * Source: the models reference shipped with Command Code, under
 * `dist/bundled/command-code-knowledge/reference/models.md`.
 *
 * The reference rounds to whole K, so `262K` is written out as 262_144: that
 * tier is the binary one (256 * 1024), while `256K` is a flat 256_000.
 */
const CATALOG: ReadonlyArray<readonly [string, number]> = [
	['deepseek/deepseek-v4-pro', 1_000_000],
	['deepseek/deepseek-v4-flash', 1_000_000],
	['deepseek/deepseek-v4-flash-vision-exp', 1_000_000],
	['deepseek/deepseek-v4-flash-fast', 1_000_000],
	['deepseek/deepseek-v4.1-flash', 1_000_000],
	['moonshotai/Kimi-K3', 1_000_000],
	['moonshotai/Kimi-K2.7-Code', 256_000],
	['moonshotai/Kimi-K2.7-Code-Highspeed', 262_144],
	['moonshotai/Kimi-K2.6', 256_000],
	['moonshotai/Kimi-K2.5', 256_000],
	['z-ai/glm-5.3-flash', 1_050_000],
	['z-ai/glm-5.3-flashx', 1_000_000],
	['zai-org/GLM-5.3', 1_000_000],
	['zai-org/GLM-5.2', 1_000_000],
	['zai-org/GLM-5.2-Fast', 1_000_000],
	['zai-org/GLM-5', 200_000],
	['MiniMaxAI/MiniMax-M3', 1_000_000],
	['MiniMaxAI/MiniMax-M2.5', 200_000],
	['xiaomi/mimo-v2.6-pro', 1_050_000],
	['xiaomi/mimo-v2.6-pro-ultraspeed', 1_050_000],
	['xiaomi/mimo-v2.6-flash', 1_050_000],
	['xiaomi/mimo-v2.5-pro', 1_000_000],
	['xiaomi/mimo-v2.5', 1_000_000],
	['Qwen/Qwen3.8-Omni-Flash', 1_000_000],
	['Qwen/Qwen3.8-Max-0902', 1_000_000],
	['Qwen/Qwen3.8-Max', 1_000_000],
	['Qwen/Qwen3.8-27B', 262_144],
	['Qwen/Qwen3.8-Flash', 1_000_000],
	['Qwen/Qwen3.7-Max', 1_000_000],
	['Qwen/Qwen3.7-Plus', 1_000_000],
	['Qwen/Qwen3.7-Flash', 1_000_000],
	['meituan/LongCat-2.0', 1_050_000],
	['stepfun/Step-5-Preview', 1_000_000],
	['stepfun/Step-3.7-Flash', 256_000],
	['stepfun/Step-3.5-Flash', 1_000_000],
	['tencent/hy3-paid', 262_144],
	['tencent/hy4-preview', 1_050_000],
	['nvidia/nemotron-3-ultra-550b-a55b', 1_000_000],
	['thinkingmachines/inkling', 256_000],
	['thinkingmachines/inkling-small', 1_000_000],
	['poolside/laguna-s-2.1-free', 256_000],
	['inclusionai/ling-3.0-flash-sante:free', 262_144],
	['claude-sonnet-5', 1_000_000],
	['claude-sonnet-4-6', 1_000_000],
	['claude-fable-5-1', 1_000_000],
	['claude-fable-5', 1_000_000],
	['claude-opus-5-5', 1_000_000],
	['claude-opus-5', 1_000_000],
	['claude-opus-4-8', 1_000_000],
	['claude-opus-4-7', 1_000_000],
	['claude-haiku-4-5-20251001', 200_000],
	['gpt-6-astra', 1_050_000],
	['gpt-6-sol', 1_050_000],
	['gpt-6-luna', 1_050_000],
	['gpt-5.6-sol', 1_050_000],
	['gpt-5.6-terra', 1_050_000],
	['gpt-5.6-luna', 1_050_000],
	['gpt-5.5', 400_000],
	['gpt-5.4', 400_000],
	['gpt-5.3-codex', 400_000],
	['gpt-5.4-mini', 400_000],
	['google/gemini-3.8-flash', 1_000_000],
	['google/gemini-3.7-flash', 1_050_000],
	['google/gemini-3.6-flash', 1_000_000],
	['google/gemini-3.5-flash', 1_000_000],
	['google/gemini-3.5-flash-lite', 1_000_000],
	['google/gemini-3.1-flash-lite', 1_000_000],
	['sakana/fugu-ultra', 1_000_000],
	['meta/muse-spark-1.1', 1_050_000],
	['meta/muse-spark-1.2', 1_050_000],
	['meta/muse-spark-1.2-contributor', 1_050_000],
	['meta/muse-spark-1.3', 1_050_000],
	['meta/muse-spark-1.3-contributor', 1_050_000],
	['xai/grok-4.5', 500_000],
	['xai/grok-4.6', 500_000],
	['xai/grok-4.7', 500_000],
];

/** Catalog ids the CLI lists without publishing a context window for. */
const UNDOCUMENTED: ReadonlyArray<string> = [
	'zai-org/GLM-5.1',
	'MiniMaxAI/MiniMax-M2.7',
	'Qwen/Qwen3.6-Max-Preview',
	'Qwen/Qwen3.6-Plus',
];

const describe = (id: string, size: number, estimated: boolean) => `${id} -> ${estimated ? '~' : ''}${size}`;

test('every published model resolves to exactly the window the CLI documents', () => {
	const wrong: string[] = [];
	for (const [id, want] of CATALOG) {
		const got = windowFor(id, 0);
		if (got.estimated || got.limit !== want) wrong.push(`${describe(id, got.limit, got.estimated)} (want ${want})`);
	}
	assert.deepEqual(wrong, []);
});

test('no published model is reported as an estimate', () => {
	const missing = [...CATALOG.map(([id]) => id), ...UNDOCUMENTED].filter((id) => windowFor(id, 0).estimated);
	assert.deepEqual(missing, []);
});

test('a model the table does not know falls back to the default, flagged as estimated', () => {
	assert.deepEqual(windowFor('vendor/brand-new-model-9', 0), {limit: DEFAULT_WINDOW, estimated: true});
});

test('an explicit override beats the table and stops being an estimate', () => {
	assert.deepEqual(windowFor('claude-haiku-4-5-20251001', 1_000_000), {limit: 1_000_000, estimated: false});
	assert.deepEqual(windowFor('vendor/brand-new-model-9', 1_000_000), {limit: 1_000_000, estimated: false});
});

test('model ids match case-insensitively and tolerate a vendor prefix', () => {
	assert.deepEqual(windowFor('Claude-Opus-5', 0), windowFor('claude-opus-5', 0));
	assert.deepEqual(windowFor('OPENAI/GPT-5.5', 0), {limit: 400_000, estimated: false});
});

test('every rule can actually fire', () => {
	// A needle no published id contains is either a typo or a model that has
	// since been renamed away; either way it is dead weight in a table that is
	// maintained by hand.
	const unreachable = WINDOW_RULES.filter(([needle]) => !CATALOG.some(([id]) => id.toLowerCase().includes(needle))).map(([needle]) => needle);
	assert.deepEqual(unreachable, []);
});

test('a specific rule never sits below a broader one it contains', () => {
	// windowFor() stops at the first `includes()` hit, so ['claude', 200K]
	// placed above ['claude-sonnet', 1M] would silently report Sonnet as 200K.
	// Sorting this table alphabetically, or inserting a row at the top, is the
	// regression this guards.
	const misplaced: string[] = [];
	WINDOW_RULES.forEach(([needle, size], later) => {
		WINDOW_RULES.forEach(([other, otherSize], earlier) => {
			if (earlier < later && needle.includes(other) && size !== otherSize) {
				misplaced.push(`'${needle}' (${size}) at ${later} is shadowed by '${other}' (${otherSize}) at ${earlier}`);
			}
		});
	});
	assert.deepEqual(misplaced, []);
});
