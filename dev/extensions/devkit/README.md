# devkit (dev-only extension)

Local development helper that is loaded only by [`./pitest`](../../../pitest),
not by the normal pi install flow (it lives under `dev/extensions/`).

## What it does

- `Alt+Ctrl+R` reloads extensions, skills, prompts, and themes.

## How

Shortcut handlers get `ExtensionContext`, which cannot reload. The shortcut
dispatches an internal `devkit:reload` command via `pi.sendUserMessage(...,
{ expandPromptTemplates: true })`, and the command calls `ctx.reload()`.

Reloading is blocked while the agent is streaming, matching the built-in
`/reload` behavior.
