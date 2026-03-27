# tool-zellij (pi extension)

Adds a `zellij` tool that acts as a bridge between pi and a local zellij/tmux setup.

## Current supported sub-tools

- `help` — shows all currently supported bridge sub-tools
- `version` — runs `zellij --version` and returns the installed version

## Tool parameters

- `action` (required): one of `help` or `version`

## Install

Copy this folder into a standard pi extension location:

- Global: `~/.pi/agent/extensions/tool-zellij/`
- Project-local: `.pi/extensions/tool-zellij/`

Then run `/reload`.
