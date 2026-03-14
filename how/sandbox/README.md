# `pi-bwrap`

`pi-bwrap` runs `pi` inside a `bubblewrap` sandbox with a deliberately small host view.

The goal of this wrapper is practical isolation for day-to-day agent use:

- the current git repo or worktree is the only persistent writable area
- most of `$HOME` is hidden
- standard system binaries and libraries remain available read-only
- networking works
- temporary files are private to the sandbox

This is not a hardened container runtime and it is not a full MAC policy. It is a pragmatic filesystem and process boundary around `pi`.

## What It Does

On startup, the script:

1. checks that `bwrap` is installed
2. checks that the current directory is inside a git repo or worktree
3. resolves the repo root and preserves the current subdirectory as the sandbox working directory
4. builds a minimal `bubblewrap` environment
5. launches `pi` by default, or another command if one was provided after `--`

Examples:

```bash
./pi-bwrap
./pi-bwrap -- model list
./pi-bwrap -- git status
./pi-bwrap --debug
```

If you pass a command explicitly, the wrapper runs that command inside the same sandbox instead of `pi`.

## Filesystem Policy

The current implementation uses a broad read-only host runtime plus a narrow writable workspace.

### Writable

The following locations are writable:

- the current git repo or worktree, mounted at its real absolute path
- `~/.pi/agent`, mounted into the sandbox home as writable
- private `tmpfs` mounts at `/tmp` and `/var/tmp`

Important details:

- the repo is mounted directly, not through an overlay
- `.git` is writable because you wanted normal git usage to work
- writes in the repo affect the real working tree immediately
- `/tmp` and `/var/tmp` are sandbox-private and do not expose the host directories

### Read-Only

The following host paths are mounted read-only when present:

- `/usr`
- `/bin`
- `/lib`
- `/lib64`
- `/usr/share/zoneinfo`
- `/etc/localtime`
- `/etc/resolv.conf`
- `/etc/hosts`
- `/etc/nsswitch.conf`
- `/etc/passwd`
- `/etc/group`
- `/etc/ssl`
- `/etc/pki`
- `/etc/ca-certificates`
- `~/.pi`
- `~/.bashrc`
- `~/.gitconfig`
- `~/.local/share/mise`
- `SSH_AUTH_SOCK` if it points to a valid socket

Why `~/.local/share/mise` is included:

- on this machine, `pi` and `node` are installed under the `mise` tree rather than under `/usr`
- without that mount, the sandbox can see `/usr/bin/env` but not the actual `pi` launcher or its Node runtime

### Hidden / Not Mounted

Everything else is absent by default unless added explicitly later.

That means, in practice:

- the rest of your real home directory is not visible
- arbitrary sibling project directories are not visible
- host `/tmp` and `/var/tmp` are not visible
- `/run` is not mounted broadly
- only the SSH agent socket is allowed through from local IPC, if present

## Virtual Home Directory

Inside the sandbox, `HOME` is not your real home directory. It is set to:

```text
/home/pi-sandbox
```

That directory is backed by an empty temporary directory created by the wrapper at launch time. Selected files and directories are then mounted into it:

- `~/.pi` as read-only
- `~/.pi/agent` as writable
- `~/.bashrc` as read-only
- `~/.gitconfig` as read-only

This gives `pi` and related tooling a stable home path without exposing the rest of your real home directory.

The temporary backing directory is removed when the wrapper exits.

## Process and Namespace Behavior

The wrapper currently uses:

- `--unshare-all`
- `--share-net`
- `--new-session`
- `--die-with-parent`
- `--proc /proc`
- `--dev /dev`

What that means operationally:

- the process runs in fresh namespaces rather than directly in the host context
- network access remains enabled
- child processes stay inside the same sandbox
- when the wrapper process dies, the sandbox should die with it
- a normal sandbox `/proc` is available
- a minimal sandbox `/dev` is available

## Environment Policy

The wrapper starts from `--clearenv` and then selectively restores a small baseline environment.

Always set:

- `HOME`
- `PATH`
- `USER`
- `LOGNAME`
- `SHELL`

Conditionally forwarded when present:

- `TERM`
- `LANG`
- `TZ`
- all `LC_*` variables
- `SSH_AUTH_SOCK` if it points to a real socket

This keeps enough user and locale context for normal CLI behavior while avoiding a full copy of the host shell environment.

## Git Behavior

Git is expected to work normally inside the repo because:

- the repo is writable
- `.git` is writable as part of that repo mount
- `~/.gitconfig` is available read-only
- your current directory inside the repo is preserved

This was an intentional tradeoff. Hiding `.git` while still expecting real git operations is not practical.

## Networking and TLS

The sandbox keeps network access enabled.

To make DNS and HTTPS function, the wrapper includes a minimal set of read-only `/etc` paths commonly needed by userland tools:

- resolver configuration
- host resolution configuration
- CA certificate directories
- time and timezone data

This is intentionally narrower than mounting all of `/etc`, but broader than a strictly offline sandbox.

## SSH Agent Access

If `SSH_AUTH_SOCK` exists and points to a socket, the wrapper mounts that socket path read-only into the sandbox and forwards the environment variable.

This allows agent-based authentication, for example `git` over SSH, without exposing private key files from your home directory.

No broader `/run` mount is provided.

## Debug Mode

`--debug` runs the sandboxed command under `strace`.

Example:

```bash
./pi-bwrap --debug
./pi-bwrap --debug -- git status
```

The trace is written to:

```text
<repo>/.pi-bwrap-strace.log
```

Use this when a tool fails because some file, directory, or runtime dependency is missing from the sandbox. The intended workflow is:

1. reproduce the failure with `--debug`
2. inspect the trace for missing paths or denied access
3. decide whether that path should be mounted into the sandbox
4. keep the allowlist small

## Startup Failure Modes

The wrapper fails early in these cases:

- `bwrap` is not installed
- the current directory is not inside a git repo or worktree
- the command to run cannot be found on the host before launching the sandbox
- `--debug` was requested but `strace` is not installed
- `HOME` is not set

Optional binds are best-effort. If a configured path does not exist, the wrapper skips that bind and keeps going.

## Known Limitations

This is the first practical version, not a finished policy engine.

Current limitations include:

- no secret file denylist enforcement
- no pattern-based blocking for `.env` or other sensitive files
- no overlay or copy-on-write mode for the repo
- no broad `/etc` compatibility layer beyond the explicitly mounted paths
- no broad `/run` support beyond the SSH agent socket

Also important:

- the repo is mounted directly read-write, so mistakes inside the sandbox affect the real working tree
- `bubblewrap` behavior depends on kernel and distro support for user namespaces
- some environments block `bwrap` entirely or partially, even if the script itself is correct

## Why The Script Looks This Way

A few design choices are worth calling out explicitly:

- The repo is mounted at its real path rather than remapped to `/workspace`.
  This keeps path expectations stable for tools and for the agent.

- The home directory is remapped to `/home/pi-sandbox`.
  This avoids accidentally shadowing the real repo path under `/home/<user>/...` while still giving tools a conventional `HOME`.

- `~/.pi` is mostly read-only, but `~/.pi/agent` is writable.
  This keeps the agent’s mutable state working without making all of `~/.pi` writable.

- `~/.local/share/mise` is mounted read-only.
  This is a machine-specific compatibility choice because `pi` is installed there.

## Next Improvements

If you want to tighten or extend this wrapper later, the most likely follow-up changes are:

- add a secrets policy
- add an optional overlay mode for the repo
- make the mounted `/etc` set configurable
- add explicit logging of the generated `bwrap` command in debug mode
- add automated self-tests for mount layout and environment behavior
