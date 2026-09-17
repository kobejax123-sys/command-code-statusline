// Command Code status line mod: <dir> · <branch> · <ctx bar> · <cache hit> · <model> <effort>
//
// Everything here runs inside the Command Code process (no sandbox). Two data
// sources are private to the CLI and can change between versions:
//
//   ~/.commandcode/config.json
//     { model: string, reasoningEffort: { [modelId]: 'low'|'medium'|'high'|'xhigh'|'max' } }
//     The file name is environment dependent: config.json (prod),
//     config.local.json, config.staging.json.
//
//   ~/.commandcode/projects/<slug>/<sessionId>.jsonl   (one JSON object per line)
//     { type: 'session', version, cwd, ... }
//     { type: 'effort_change', effort }
//     { type: 'message', usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}, model, effort }
//
// `usage.inputTokens` is the whole input (uncached + cache read + cache write),
// which is what the dashboard calls "Input All" and what the provider bills on.

import {closeSync, openSync, readFileSync, readSync, readdirSync, statSync, watch} from 'node:fs';
import {basename, join} from 'node:path';

import type {ModApi} from '@commandcode/harness';

const DEFAULT_WINDOW = 200_000;

const SNAPSHOT_TYPE = 'statusline/snapshot';

const CONFIG_NAMES = ['config.json', 'config.local.json', 'config.staging.json'];

const homeDir = () => process.env.HOME ?? process.env.USERPROFILE;

const readConfig = () => {
	const home = homeDir();
	if (!home) return undefined;
	for (const name of CONFIG_NAMES) {
		try {
			return JSON.parse(readFileSync(join(home, '.commandcode', name), 'utf8'));
		} catch {}
	}
	return undefined;
};

const effortFor = (config: any, model: string) => {
	const table = config?.reasoningEffort;
	return model && table && typeof table === 'object' ? String(table[model] ?? '') : '';
};

const readDefaults = (forModel?: string) => {
	const config = readConfig();
	if (!config) return {model: '', effort: ''};
	const model = typeof config.model === 'string' ? config.model : '';
	return {model, effort: effortFor(config, forModel ?? model)};
};

const normalizePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

const sessionCwd = (file: string) => {
	try {
		const fd = openSync(file, 'r');
		try {
			// The header is a single JSON object on the first line and its length
			// is not bounded in practice, so read forward until the newline
			// instead of assuming it fits in one fixed-size buffer.
			let text = '';
			let offset = 0;
			while (offset < 1_048_576) {
				const buffer = Buffer.alloc(4096);
				const bytes = readSync(fd, buffer, 0, 4096, offset);
				if (bytes <= 0) break;
				offset += bytes;
				text += buffer.toString('utf8', 0, bytes);
				if (text.includes('\n')) break;
			}
			const entry = JSON.parse(text.split('\n')[0]);
			return typeof entry?.cwd === 'string' ? entry.cwd : undefined;
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
};

const newestSession = (dir: string) => {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith('.jsonl') && !name.includes('checkpoints'))
			.map((name) => ({file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs}))
			.sort((a, b) => b.mtime - a.mtime)[0];
	} catch {
		return undefined;
	}
};

// Heuristic: the most recently touched session file whose header cwd matches the
// current directory. Not guaranteed to be the session that is actually bound.
const sessionFile = (cwd: string) => {
	const home = homeDir();
	if (!home) return undefined;
	const projects = join(home, '.commandcode', 'projects');
	const target = normalizePath(cwd);
	try {
		let newest;
		for (const name of readdirSync(projects)) {
			const candidate = newestSession(join(projects, name));
			if (!candidate || normalizePath(sessionCwd(candidate.file) ?? '') !== target) continue;
			if (!newest || candidate.mtime > newest.mtime) newest = candidate;
		}
		return newest?.file;
	} catch {
		return undefined;
	}
};

// Walk backwards through the file in chunks and return the first entry (newest
// first) that `want` accepts. Keeps memory flat on multi-megabyte transcripts.
const scanTail = (file: string, want: (entry: any) => boolean, limit = 16 * 1024 * 1024) => {
	const chunk = 256 * 1024;
	let fd;
	try {
		fd = openSync(file, 'r');
		let position = statSync(file).size;
		let scanned = 0;
		let carry = '';

		const parse = (line: string) => {
			if (line.length < 2) return undefined;
			try {
				const entry = JSON.parse(line);
				return want(entry) ? entry : undefined;
			} catch {
				return undefined;
			}
		};

		while (position > 0 && scanned < limit) {
			const length = Math.min(chunk, position);
			position -= length;
			scanned += length;

			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, position);

			const lines = (buffer.toString('utf8') + carry).split('\n');
			carry = lines.shift() ?? '';

			for (let i = lines.length - 1; i >= 0; i--) {
				const hit = parse(lines[i]);
				if (hit) return hit;
			}
		}

		return parse(carry);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

// Cache reads are a subset of inputTokens, so the ratio is bounded by 100. The
// clamp matters if a provider ever reports inputTokens without the cached part.
const cacheHitRate = (usage: any) => {
	const input = usage?.inputTokens ?? 0;
	if (!(input > 0)) return -1;
	return Math.min(100, ((usage.cacheReadTokens ?? 0) / input) * 100);
};

const readHistory = (cwd: string) => {
	const file = sessionFile(cwd);
	if (!file) return undefined;
	const entry = scanTail(file, (candidate) => !!candidate?.usage?.inputTokens);
	if (!entry) return undefined;
	return {
		model: typeof entry.model === 'string' ? entry.model : '',
		effort: typeof entry.effort === 'string' ? entry.effort : '',
		used: entry.usage.inputTokens,
		hit: cacheHitRate(entry.usage),
	};
};

// Context windows for the models this CLI serves. There is no API to ask for
// this, so it is a lookup table; anything unmatched shows as an estimate (≈) and
// can be overridden with --mod-option statusline.context=<tokens>.
const WINDOW_RULES: ReadonlyArray<readonly [string, number]> = [
	['kimi-k2.7-code-highspeed', 262_144],
	['qwen3.8-27b', 262_144],
	['glm-5.3', 1_000_000],
	['glm-5.2', 1_000_000],
	['glm-5.1', 200_000],
	['inkling-small', 1_000_000],
	['minimax-m3', 1_000_000],
	['minimax-m2', 200_000],
	['gpt-5.6', 1_100_000],
	['claude', 200_000],
	['grok', 500_000],
	['gemini', 1_000_000],
	['muse-spark', 1_000_000],
	['nemotron', 1_000_000],
	['longcat', 1_000_000],
	['mimo', 1_000_000],
	['kimi-k3', 1_000_000],
	['kimi-k2.7', 256_000],
	['kimi-k2.6', 256_000],
	['kimi-k2.5', 256_000],
	['glm-5', 200_000],
	['qwen3.6', 200_000],
	['qwen', 1_000_000],
	['deepseek', 1_000_000],
	['hy4', 1_000_000],
	['hy3', 262_144],
	['step-3.7', 256_000],
	['step-3.5', 1_000_000],
	['inkling', 256_000],
	['laguna', 256_000],
	['ling-3', 262_144],
];

const RESET = '\u001b[0m';
const SEP = '\u001b[38;2;80;85;95m';
const FAINT = '\u001b[38;2;100;105;115m';
const PURPLE = '\u001b[38;2;185;150;255m';
const GREEN = '\u001b[32m';
const CYAN = '\u001b[36m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[38;2;235;115;115m';

const NO_COLOR = Boolean(process.env.NO_COLOR);

const style = (code: string, text: string) => (NO_COLOR ? text : `${code}${text}${RESET}`);

const bar = (pct: number, tone: string, width = 10) => {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	const solid = filled > 0 ? style(tone, '█'.repeat(filled)) : '';
	return `${solid}${style(SEP, '░'.repeat(width - filled))}`;
};

const shortModel = (model: string) =>
	(model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model).replace(/:free$/, '');

const EFFORT_RANK: Record<string, number> = {low: 1, medium: 2, high: 3, xhigh: 4, max: 5};

// Returns the stars and their trailing space, or nothing when the level is not
// in the table — an unknown level rendered as a single star would read as
// "✦ default", implying a low-effort rank that was never reported.
const effortIcon = (effort: string) => {
	const rank = EFFORT_RANK[effort.toLowerCase()];
	return rank ? `${'✦'.repeat(rank)} ` : '';
};

// 0 = not set, >0 = token count, -1 = unparseable (the caller warns).
const parseContextOverride = (raw: unknown) => {
	const text = String(raw ?? '').trim();
	if (!text) return 0;
	const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(text);
	if (!match) return -1;
	const scale = match[2] ? (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000) : 1;
	const value = Math.round(Number(match[1]) * scale);
	return value > 0 ? value : -1;
};

const windowFor = (model: string, override: number) => {
	if (override > 0) return {limit: override, estimated: false};
	const id = model.toLowerCase();
	for (const [needle, size] of WINDOW_RULES) if (id.includes(needle)) return {limit: size, estimated: false};
	return {limit: DEFAULT_WINDOW, estimated: true};
};

const humanTokens = (n: number) =>
	n >= 1_000_000
		? `${(n / 1_000_000).toFixed(1)}M`
		: n >= 1_000
			? `${Math.round(n / 1_000)}K`
			: String(n);

const shortenPath = (path: string) => basename(path) || path;

export default function statusline(cmd: ModApi) {
	cmd.addFlag('statusline.context', {
		type: 'string',
		default: '',
		description: 'Override the context window size in tokens (e.g. 200000 or 1M)',
	});

	let model = '';
	let effort = '';
	let used = 0;
	let hit = -1;
	let branch = '';
	let visible = true;
	let lastSnapshot = '';
	let historyTries = 0;
	let resumed = false;
	let warned = false;
	let ticks = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let watcher: ReturnType<typeof watch> | undefined;
	let watchTimer: ReturnType<typeof setTimeout> | undefined;

	const draw = () => {
		if (!visible || !cmd.ui.capabilities.status) return;
		const segs: string[] = [style(YELLOW, shortenPath(cmd.cwd))];
		if (branch) segs.push(`${style(PURPLE, '⎇')} ${style(PURPLE, branch)}`);
		if (model) {
			if (used > 0) {
				const flag = cmd.getFlag('statusline.context');
				const override = parseContextOverride(flag);
				if (override < 0) warn(`invalid statusline.context "${String(flag)}": expected a token count like 200000 or 1M`);
				const {limit, estimated} = windowFor(model, override > 0 ? override : 0);
				const raw = (used / limit) * 100;
				const pct = Math.min(100, Math.round(raw));
				const tone = raw >= 85 ? RED : raw >= 60 ? YELLOW : GREEN;
				const mark = estimated ? '≈' : '';
				segs.push(
					`${bar(pct, tone)} ${style(tone, `${mark}${pct}%${raw > 100 ? '+' : ''}`)} ${style(FAINT, `${humanTokens(used)}/${mark}${humanTokens(limit)}`)}`,
				);
			} else {
				segs.push(`${bar(0, SEP)} ${style(FAINT, '--')}`);
			}

			if (hit >= 0) {
				const tone = hit >= 80 ? GREEN : hit >= 40 ? YELLOW : RED;
				segs.push(`${style(tone, '⚡')} ${style(tone, `${hit.toFixed(1)}%`)}`);
			} else {
				segs.push(style(FAINT, '⚡ --'));
			}

			const level = effort ? style(PURPLE, `${effortIcon(effort)}${effort}`) : style(FAINT, 'default');
			segs.push(`${style(CYAN, shortModel(model))} ${level}`);
		}
		cmd.ui.setStatus(segs.join(style(SEP, ' · ')));
	};

	const refreshBranch = async () => {
		try {
			let next = '';
			try {
				const r = await cmd.exec({command: 'git', args: ['branch', '--show-current'], cwd: cmd.cwd});
				if (r.code === 0) next = r.stdout.trim();
			} catch {
				next = '';
			}
			if (next !== branch) {
				branch = next;
				draw();
			}
		} catch (error) {
			warn(error);
		}
	};

	const warn = (error: unknown) => {
		if (warned) return;
		warned = true;
		try {
			cmd.ui.notify(`statusline: ${error instanceof Error ? error.message : String(error)}`);
		} catch {}
	};

	const tryHistory = () => {
		if (used !== 0) return;
		try {
			const history = readHistory(cmd.cwd);
			if (!history) return;
			if (history.model) model = history.model;
			if (history.effort) effort = history.effort;
			used = history.used;
			hit = history.hit;
			draw();
		} catch (error) {
			warn(error);
		}
	};

	const attachWatcher = () => {
		if (watcher) return;
		const home = homeDir();
		if (!home) return;
		try {
			watcher = watch(join(home, '.commandcode'), (_event: any, filename: any) => {
				// The host saves config atomically (write temp + rename), so the
				// reported name may be the temp file or the target; accept both.
				if (!String(filename ?? '').startsWith('config.')) return;
				if (watchTimer) return;
				watchTimer = setTimeout(() => {
					watchTimer = undefined;
					const config = readConfig();
					if (!config) return;
					const nextModel = typeof config.model === 'string' && config.model ? config.model : model;
					const nextEffort = effortFor(config, nextModel);
					let changed = false;
					if (nextModel !== model) {
						model = nextModel;
						changed = true;
					}
					if (nextEffort !== effort) {
						effort = nextEffort;
						changed = true;
					}
					if (changed) draw();
				}, 120);
				watchTimer.unref?.();
			});
			watcher.unref?.();
		} catch (error) {
			watcher = undefined;
			warn(error);
		}
	};

	cmd.on('model_request_end', (event: any) => {
		if (!event?.usage) return;
		if (event.model) model = String(event.model);
		// Cleared rather than kept when the field is absent: a switch to a model
		// without effort support would otherwise keep showing the old value.
		effort = event.effort ? String(event.effort) : '';
		used = event.usage.inputTokens ?? 0;
		hit = cacheHitRate(event.usage);

		draw();
	});

	cmd.on('compaction_done', () => {
		// The old number is meaningless now. `tokensSaved` is measured on the
		// client's estimation basis, not on usage.inputTokens, so subtracting it
		// overshoots (measured ~58K high). Show "--" until the next request
		// reports the real size.
		used = -1;
		hit = -1;
		draw();
	});

	cmd.on('config_setting_changed', (event: any) => {
		if (event?.setting === 'effort') {
			effort = typeof event.value === 'string' ? event.value : '';
			draw();
			return;
		}
		if (event?.setting === 'model' && typeof event.value === 'string' && event.value) {
			model = event.value;
			effort = readDefaults(event.value).effort;
			draw();
		}
	});

	cmd.on('turn_end', () => {
		void refreshBranch();
	});

	cmd.hooks({
		onSessionStart: (event: any, ctx: any) => {
			if (timer) clearInterval(timer);
			timer = undefined;

			try {
				const defaults = readDefaults();
				if (!model) model = defaults.model;
				if (!effort) effort = defaults.effort;

				const snapshot = (ctx?.session?.getCustomEntries({customType: SNAPSHOT_TYPE}) ?? []).pop();
				const restored = snapshot?.data ?? snapshot;
				if (restored && typeof restored === 'object') {
					if (typeof restored.model === 'string' && restored.model) model = restored.model;
					if (typeof restored.effort === 'string') effort = restored.effort;
					if (typeof restored.used === 'number') used = restored.used;
					if (typeof restored.hit === 'number') hit = restored.hit;
				}
			} catch (error) {
				warn(error);
			}

			resumed = event?.source === 'resume';
			if (resumed) tryHistory();
			attachWatcher();

			void refreshBranch();
			draw();
			timer = setInterval(() => {
				ticks += 1;
				attachWatcher();
				// Bounded retries: a resumed session may not have flushed a usage
				// record yet, so poll a few times. After these we stop compensating,
				// so if the user never sends a message `used` stays at the restored
				// value (or "--") until the first request reports the real number.
				if (resumed && used === 0 && historyTries < 8) {
					historyTries += 1;
					tryHistory();
				}
				// Redraw on the branch-refresh tick only. Everything else is driven
				// by events, so drawing on every tick just re-renders identical text.
				if (ticks % 4 === 1) {
					void refreshBranch();
					draw();
				}
			}, 15_000);
			timer.unref?.();

			const settle = setTimeout(() => draw(), 800);
			settle.unref?.();
		},
		onSessionEnd: () => {
			if (timer) clearInterval(timer);
			timer = undefined;
			if (watchTimer) clearTimeout(watchTimer);
			watchTimer = undefined;
			watcher?.close();
			watcher = undefined;
			historyTries = 0;
			lastSnapshot = '';
			cmd.ui.setStatus(null);
		},
		onRunEnd: (_event: any, ctx: any) => {
			if (!ctx?.session || !model) return;
			const data = {model, effort, used, hit};
			const json = JSON.stringify(data);
			if (json === lastSnapshot) return;
			lastSnapshot = json;
			try {
				ctx.session.appendCustomEntry({customType: SNAPSHOT_TYPE, data});
			} catch {}
		},
	});

	cmd.addCommand({
		name: 'statusline',
		description: 'Toggle the status line',
		argumentHint: '[on|off]',
		handler: ({args}) => {
			const arg = String(args ?? '').trim().toLowerCase();
			if (arg === 'off' || arg === 'hide') visible = false;
			else if (arg === 'on' || arg === 'show') visible = true;
			else visible = !visible;

			if (visible) {
				void refreshBranch();
				draw();
			} else {
				cmd.ui.setStatus(null);
			}
			return {message: visible ? 'status line shown' : 'status line hidden'};
		},
	});
}
