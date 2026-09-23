# command-code-statusline

[Command Code](https://commandcode.ai) 的状态栏 mod：项目目录、git 分支、上下文占用、缓存命中率、当前模型 + 思考强度，全部压在 TUI 底部一行里。

```
yuehui.xu · ⎇ main · ███░░░░░░░ 31% 310K/1.0M · ⚡ 99.7% · deepseek-v4.1-flash ✦✦✦ high
└───┬───┘   └──┬─┘   └───────┬────────┘   └───┬───┘   └────────┬─────────┘
  目录名      分支      上下文占用       缓存命中      模型 + 思考强度
```

## 安装

```bash
# -g = user scope：对所有项目生效（状态栏建议这样装）
cmd mods add -g kobejax123-sys/command-code-statusline
```

然后 `/reload` 或重启 Command Code，用 `cmd mods list` 确认，应该看到 `statusline · user · …`。

不加 `-g` 只会装进当前项目，换个目录就没有了。

### 手动安装

clone 本仓库（或直接下载 `statusline.ts`），把文件复制进 `~/.commandcode/mods/`，再 `/reload`。那个目录不需要 manifest —— Command Code 会自动扫描。

### 本地开发

只留一份副本，用软链指过去，这样你改的就是实际运行的那份：

```bash
ln -sf "$PWD/statusline.ts" ~/.commandcode/mods/statusline.ts
```

之后每次改完 `/reload` 即可生效。

两个校验都不需要测试框架：`npm run typecheck`（严格 `tsc`）和 `npm test`（Node 内置 runner，需 Node >= 22.18）。`npm test` 会把 `WINDOW_RULES` 与 Command Code 公布的各模型上下文窗口逐条比对——其中也包括「这张表的正确性依赖数组顺序」这一点，所以改动这张表后务必跑一次。

## 用法

| 命令 | 作用 |
| --- | --- |
| `/statusline` | 切换显示 / 隐藏 |
| `/statusline on` \| `/statusline off` | 显式显示 / 隐藏 |
| `cmd --mod-option statusline.context=1000000` | 当模型不在窗口表里时，手动指定上下文窗口 |

## 这些数字是什么意思

**上下文占用**取自 provider 返回的 `usage.inputTokens` —— 也就是全部输入（未缓存 + 缓存读 + 缓存写），官方 dashboard 里叫 *Input All*，也是实际计费的量。这是精确计数，不是估算。

**缓存命中率** = `cacheReadTokens / inputTokens`，即这次输入里有多少比例走了 prompt cache。

**上下文窗口**没法通过 mod API 读到，所以源码里维护了一张查找表（`WINDOW_RULES`）。模型不在表里时数字会带估算标记（`≈31% 310K/~200K`）—— 那就当它是猜的，用上面的 `--mod-option` 覆盖。

**思考强度**用 1~5 个 `✦` 表示（`low` → `max`），一眼能看出档位；模型不报 effort 时显示 `default`。

### 为什么有时显示 `--`

- **新开会话** —— 还没有任何请求，没有 usage 可读。占位符留在原处是为了让整行不跳动，发第一条消息后就会出现真实数字。
- **刚执行完 `/compact`** —— 之前的数字已经不能描述当前上下文了。压缩事件会报 `tokensSaved`，但它按客户端的估算口径统计，和 `usage.inputTokens` 不是一个基准，直接相减会高估（在 270K 上下文上实测偏高约 58K）。所以宁可显示 `--`，等下一次请求报出真实值。

## 隐私

这个 mod 只读两处本地文件，都是只读：

- `~/.commandcode/config.json` —— 当前模型和它的 `reasoningEffort` 映射
- `~/.commandcode/projects/**/*.jsonl` —— 会话记录，仅用于 `--resume` 后恢复上一次的用量/模型/强度

不会写入，也不会发送到任何地方。没有网络请求，没有遥测。读取也是有界的：从最新匹配文件的末尾往前扫，拿到需要的那条记录就停。

## 已知限制

- mod API 目前是 **experimental**，而上面两个文件都是私有格式 —— Command Code 升级可能改动其中任何一个。代码里每处读取都包了兜底，最坏情况是静默显示 `--`，不会崩。
- 窗口表会随新模型上线而过时。欢迎 PR，或者用上面的 flag 在运行时覆盖。
- 渲染假设终端是 UTF-8 且字体含 `█ ░ ⚡ ✦ ⎇` 这些字形。设 `NO_COLOR=1` 可关闭 ANSI 配色。

## License

MIT —— 见 [LICENSE](./LICENSE)。
