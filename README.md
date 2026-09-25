# Shitty Extensions

for [shittycodingagent.ai](https://shittycodingagent.ai/).

<p align="center">
  <img src="docs/images/pi-x.webp" alt="pi-x" />
</p>

This repo currently contains the following extension(s):

| name | description | dependencies |
| --- | --- | --- |
| [`status-bar`](extensions/status-bar/README.md) | **Required shared dependency** for other status-producing extensions in this repo. Install this first. | |
| [`no-reflection`](extensions/no-reflection/README.md) | Removes pi's built-in documentation reference block from the agent system prompt without dumping the prompt anywhere. Disable with `PI_NO_REFLECTION=false`, `no`, `n`, or `0`. | |
| [`switch-thinking`](extensions/switch-thinking/README.md) | Adds fast keyboard workflows for thinking modes: `Ctrl+Alt+T` opens a picker, and `Ctrl+T` cycles your saved favorites. | `status-bar` |
| [`review-level`](extensions/review-level/README.md) | Adds `/px:review` with session-scoped `auto`, `off`, `minimal`, `normal`, and `high` review recommendations, injects explicit guidance into the agent prompt, and shows an eye icon in the editor border. | `status-bar` |
| [`safe-mode`](extensions/safe-mode/README.md) | Intercepts tool calls and enforces approval policies with four modes: `paranoid`, `reader`, `smart`, and `yolo`. | `status-bar`, `bash-parser` |
| [`permissions-core`](extensions/permissions-core/README.md) | Headless network permission provider: validates and classifies `perm:net` requests and owns the session network policy (Auto, explicit, PARANOID). | `hub` |
| [`permissions-ui`](extensions/permissions-ui/README.md) | Adds the `/px:net` selector to configure the network policy through permissions-core. | `permissions-core` |
| [`flutter`](extensions/flutter/README.md) | Owns a `flutter run --debug` process with `/px:flutter run`, `/px:flutter reload`, `/px:flutter restart`, `/px:flutter stop`, plus `Alt+R`/`Alt+Shift+R` hot controls. | `status-bar`, `flutter` CLI |
| [`proc`](extensions/proc/README.md) | Runs and manages long-lived background processes with a `proc` tool, per-process log cursors, and a collapsible above-editor Processes widget. | `panels` |
| [`http`](extensions/http/README.md) | Adds an `http` tool backed by Node native fetch, with HTTPie-like structured request fields, curl-compatible args support, and optional web-to-Markdown (`webToMd`) conversion via `pandoc`. | `cheerio`, `pandoc` for `http_md` |
| [`sqlite`](extensions/sqlite/README.md) | Adds a `sqlite` query tool for file-backed and in-memory databases, with read-only/mutating SQL classification for safe-mode integration. | `sqlite3` CLI |
| [`interactive-bash`](extensions/interactive-bash/README.md) | Runs selected user `!` commands in a true interactive terminal (stdin works for prompts, sudo password entry, and interactive scripts). | |
| [`git`](extensions/git/README.md) | Adds a `git` tool and `/px:git` command with compact porcelain `status` output (`git status --porcelain=v1 -b`) plus filtered/range-limited `log` support. | `git` CLI |
| [`pi-ui`](extensions/pi-ui/README.md) | UI tweaks: configurable working indicator, input-expected bell, `Ctrl+,` action dialog, and transcript selection (`Alt+PgDn`/`Alt+PgUp` select and scroll, `Alt+O` toggles the selected entry). | `focus-mode` optional (Focus mode row) |
| [`pi-nvim`](extensions/pi-nvim/README.md) | Unix-socket bridge for sending prompts into a running pi session from compatible Neovim clients. | compatible Neovim plugin |
| [`attension-core`](extensions/attension-core/README.md) | Minimal attention bell: emits terminal BEL (`\u0007`) on `agent_end`, with a short cooldown and a `/px:attension-core-test` command. | |
| [`save`](extensions/save/README.md) | Adds a `/save` command to write the latest assistant response to Markdown (`/save` or `/px file.md`). | |
| [`renew`](extensions/renew/README.md) | Adds `/renew` for a fresh unnamed session that retains supported settings; `/renew -proc` stops managed processes. `+agents` is refused. | `safe-mode`, `permissions-core`, `review-level` optional; `proc` for `-proc` |
| [`prompt-stash`](extensions/prompt-stash/README.md) | Saves, clears, lists, and restores in-progress editor drafts with session-scoped persistence. | |
| [`notes`](extensions/notes/README.md) | Global free-form notes: `/px:notes` composes one, `/px:notes:list` browses and copies them from a two-pane dialog. | |
| [`hub`](extensions/hub/README.md) | Central signal hub: routes and arbitrates capability requests between extensions (`perm:shell`, `perm:io`, `perm:net`, `perm:agent`, `perm:tool`). | |
| [`subagent`](extensions/subagent/README.md) | Delegates single, parallel, and chained tasks to isolated RPC child agents. Async by default with automatic completion injection, plus explicit `execution: "blocking"`. Includes permission inheritance, approval relay, model-callable `action: "stop"`/`"steer"` controls, `/px:agents` runtime controls, session-wide model/effort rewiring (including `Inherit model`/`Inherit All` at child start) via `/px:agents:rewire`, an above-editor active-subagents widget, and `/px:agent:log`. | `panels`; `safe-mode` optional |
| [`panels`](extensions/panels/README.md) | Coordinates above-editor panels in a stable order. Both start collapsed; `Alt+P` cycles forward and `Alt+Shift+P` cycles backward. | |
| [`focus-mode`](extensions/focus-mode/README.md) | Keeps pi inside a reading column on wide monitors: `/px:focus [on [N]\|off\|set N[/bias]\|bias [N]\|config\|status]`, default 100 columns centered, `bias -100` moves it flush left, no margin on a screen that already fits. `-s` applies for the session only. `/px:focus config` is a settings dialog that previews live and has presets. | |

## Network permissions (`perm:net`)

`permissions-core` owns network policy for the built-in network tools (`http`,
`http_md`, `web_search`). The tools ask the hub for `perm:net` with normalized
request data; the hub routes it to permissions-core, which validates,
classifies, and disposes under the effective policy. `permissions-ui` provides
`/px:net`, and `status-bar` renders the effective token after the safe mode.

```text
http/http_md/web_search ──perm:net──▶ hub ──▶ permissions-core
                                                    │
                              state/changed ──▶ permissions-ui (/px:net)
                                            └──▶ status-bar (NET / NET? / NET+)
```

Decision matrix (classification → disposition):

| Policy | Trusted (`GET`/`HEAD`/`OPTIONS`, `web_search`) | Untrusted (other valid methods) |
| --- | --- | --- |
| `deny-all` | block | block |
| `ask-all` | ask | ask |
| `allow-trusted` | allow | block |
| `ask-untrusted` | allow | ask |
| `allow-all` | allow | allow |

New sessions start at `auto`, which derives from safe mode: `paranoid`/`reader`
→ `ask-all`, `smart` → `ask-untrusted`, `yolo`/`yolo+` → `allow-trusted`.
PARANOID always forces `ask-all` (gray `NET?`) while retaining the configured
choice; leaving PARANOID restores it. `/px:net` selects Auto or an explicit
policy for the current session. Malformed or invalid requests, missing
providers, timeouts, and non-interactive confirmations all fail closed.

V1 covers only those three tools. Shell commands (`curl`, `wget`, `ssh`, package
managers), Git remotes, subprocess/agent tools, MCP and custom tools, and direct
network calls from extension code are **not** covered. See
[`permissions-core`](extensions/permissions-core/README.md) for the full model
and known gaps.

## Themes

Theme files live in [`themes/`](themes/). `./install` syncs them into `~/.pi/agent/themes/`
(override the destination with `PI_THEMES_DIR`). Select one via `/settings` or set
`"theme": "<name>"` in `settings.json`.

| name | description |
| --- | --- |
| [`dark-purple`](themes/dark-purple.json) | Copy of the built-in `dark` theme with every thinking-level editor border fixed to one purple (`#a78bfa`), so the border no longer changes with thinking effort. |
| [`night-dark`](themes/night-dark.json) | Near-black surfaces (`#0d0d0d` page, `#1a1a1a` cards, `#303030` markdown borders) with `dark-purple`'s chrome kept as-is: teal accent `#8abeb7`, blue `#5f87ff` / cyan `#00d7ff` borders, and the brand purple `#8f7fb8` for the thinking border, list bullets/numbers and inline code. Semantic + syntax colors stay GitHub-dark (`#3fb950`, `#d29922`), with a custom red `#e17872` for errors and removed diff lines. |

also check the [skills repo](https://github.com/dector/skills).

## Install policy for pi agents

When installing extensions from this repository, pi agents should use the standard pi extension layout:

1. **Install from source directory** (not bundled artifacts).
2. Copy the full extension folder to one of:
   - Global: `~/.pi/agent/extensions/<name>/`
   - Project-local: `.pi/extensions/<name>/`
3. Ensure `index.ts` exists at the extension root (or `<name>/index.ts`).
4. Run `/reload` after copying/updating the extension.
