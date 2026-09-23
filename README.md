# command-code-statusline

A status line mod for [Command Code](https://commandcode.ai): project directory, git branch, context usage, prompt-cache hit rate, and the active model + reasoning effort — on one line at the bottom of the TUI.

```
yuehui.xu · ⎇ main · ███░░░░░░░ 31% 310K/1.0M · ⚡ 99.7% · deepseek-v4.1-flash ✦✦✦ high
└───┬───┘   └──┬─┘   └───────┬────────┘   └───┬───┘   └────────┬─────────┘
 directory   branch    context usage     cache hit      model + effort
```

## Install

```bash
# -g = user scope: available in every project (recommended for a status line)
cmd mods add -g kobejax123-sys/command-code-statusline
```

Then `/reload` or restart Command Code, and confirm with `cmd mods list` — you should see `statusline · user · …`.

Without `-g` the mod lands in the current project only, so it disappears as soon as you `cd` elsewhere.

### Manual install

Clone this repo (or just download `statusline.ts`) and copy the file into `~/.commandcode/mods/`, then `/reload`. That directory needs no manifest — Command Code scans it.

### Local development

Keep a single copy and symlink it, so the file you edit is the file that runs:

```bash
ln -sf "$PWD/statusline.ts" ~/.commandcode/mods/statusline.ts
```

After that `/reload` picks up every change.

Two checks, no test framework required: `npm run typecheck` (strict `tsc`) and `npm test` (Node's built-in runner, needs Node >= 22.18). `npm test` compares `WINDOW_RULES` against the context windows Command Code publishes — including the fact that the table's *order* is what makes it correct — so run it after touching that table.

## Usage

| Command | Effect |
| --- | --- |
| `/statusline` | toggle the line on/off |
| `/statusline on` \| `/statusline off` | show / hide explicitly |
| `cmd --mod-option statusline.context=1000000` | override the context window for models missing from the lookup table |

## What the numbers mean

**Context usage** comes from the provider's `usage.inputTokens` — the whole input (uncached + cache read + cache write), which is what the dashboard calls *Input All* and what you are billed on. It is a real count, not an estimate.

**Cache hit rate** is `cacheReadTokens / inputTokens`: the share of that input served from the prompt cache.

**Context window** is *not* readable through the mod API, so it comes from a lookup table in the source (`WINDOW_RULES`). When a model is not in the table the numbers are flagged as estimates (`≈31% 310K/~200K`) — treat those as a guess and override with `--mod-option statusline.context`.

**Reasoning effort** renders as one to five `✦` (`low` → `max`), so the level is readable at a glance. Models that report no effort show `default`.

### Why it sometimes shows `--`

- **Fresh session** — no request has been made yet, so there is no usage to report. The slots stay in place so the line doesn't jump around; real numbers appear after your first message.
- **Right after `/compact`** — the previous number no longer describes the context. The compaction event reports `tokensSaved`, but that is measured on the client's estimation basis rather than on `usage.inputTokens`, so subtracting it overshoots (measured ~58K high on a 270K context). It shows `--` instead of a wrong number, and the next request fills in the truth.

## Privacy

The mod reads two things — both local, both read-only:

- `~/.commandcode/config.json` — the selected model and its `reasoningEffort` mapping
- `~/.commandcode/projects/**/*.jsonl` — session transcripts, used only to restore the last usage/model/effort after a `--resume`

It never writes to them, and never sends anything anywhere. No network calls, no telemetry. The transcript read is bounded: it walks backwards from the end of the newest matching file and stops at the first record it needs.

## Caveats

- The mod API is **experimental**, and both files above are private formats — a Command Code release can change either. Every read is wrapped so the worst case is a silent `--`, never a crash.
- The window table goes stale as models ship. PRs welcome, or override at runtime with the flag above.
- Rendering assumes a terminal with UTF-8 and a font that has `█ ░ ⚡ ✦ ⎇`. Set `NO_COLOR=1` to drop ANSI styling.

## License

MIT — see [LICENSE](./LICENSE).
