# interactive-bash (pi extension)

Runs selected `!` commands in a real interactive terminal so stdin works (password prompts, `read -p`, interactive scripts).

## Why

By default, some commands run from `!` may not have a true interactive TTY in all setups.
This extension intercepts `user_bash` and executes matching commands with `stdio: inherit` while the TUI is temporarily suspended.

## Behavior

- Intercepts **user `!` commands only** (not agent `bash` tool calls)
- Uses your shell (`$SHELL`, fallback `/bin/bash`)
- Suspends pi TUI, runs command in full-screen terminal, then restores TUI

## Usage

- Force interactive execution for any command:

```bash
!i ./script-that-prompts.sh
!i sudo apt update
```

- Inline prompt bridge for common `read` usage in normal `!` mode:

```bash
!read -p "Project name: " name && echo "hello $name"
!read name && echo "hello $name"
```

  - pi shows an inline `ctx.ui.input` prompt
  - command is rewritten as `name='<your input>' && echo "hello $name"`
  - this keeps simple prompt UX inside the pi section

- Auto-interactive detection is enabled for commands containing common patterns:
  - `sudo`
  - `read` (complex forms fall back to full interactive mode)
  - `python`, `python3`, `node`, `bash`, `sh`

- Force all `!` commands to run interactively:

```bash
PI_INTERACTIVE_BASH_ALL=1 pi
```

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/interactive-bash/`
- Project-local: `.pi/extensions/interactive-bash/`

Required file:

- `index.ts`

Then run `/reload`.

## Notes

- In non-interactive modes (`-p`, json/rpc without UI), interactive fallback cannot run and returns an error result.
- Interactive command output is shown directly in your terminal. The session gets only a short status line.
- Inline `read` prompt bridging currently supports only **leading** forms like:
  - `read -p "..." var`
  - `read -r -p "..." var`
  - `read -p '...' var`
  - `read var`
  - `read -r var`
- More advanced shell constructs (`read` in loops/functions/heredocs/multiple reads) should use `!i ...`.
