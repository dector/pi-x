# Manual TUI smoke test: network permissions (`perm:net`)

Automated coverage lives in `bun test` (see the extension READMEs). This is the
manual end-to-end check for behavior that only exists in a real interactive pi
session: neo-bar rendering, `/px:net`, and the safe-mode approval dialog.

## Setup

From the repo root:

```sh
for e in neo-bar permissions-core permissions-ui http; do (cd "extensions/$e" && bun install); done
./pitest
```

`hub` has no dependencies. `pitest` loads the tracked repo extensions. Use
`safe-mode`'s `smart` default unless a step says otherwise.

## 1. Status token

Expected on the editor border bottom-left in the default `new` display mode
(the status line in `legacy` mode, set with `/px:status-bar-display-mode legacy`):

```text
SMART · NET?
```

Switch modes and confirm the token follows Auto:

| Command | Expected token |
| --- | --- |
| `/px:safe reader` | `READER · NET?` |
| `/px:safe smart` | `SMART · NET?` |
| `/px:safe yolo` | `YOLO · NET` |
| `/px:safe yolo+` | `YOLO+ · NET` |
| `/px:safe paranoid` | `PARANOID · NET?` |

Color depends on policy, not only label: deny-all/ask-all are gray (nothing
auto-approved); allow-trusted/ask-untrusted/allow-all are white.

## 2. `/px:net` selector

1. Return to `/px:safe smart`, then run `/px:net`.
2. Confirm the rows: Auto plus Deny all, Ask for all, Allow trusted, Ask if
   untrusted, Allow all. The current choice is preselected; the selector never
   cycles blindly.
3. Pick **Allow all** → token becomes white `NET+`, and the selection persists
   across `/px:safe` changes.
4. Run `/px:net` again, pick **Auto** → the token returns to the safe-mode
   derived value above.

## 3. PARANOID override

1. Set `/px:safe smart`, then choose **Allow all** with `/px:net`. Token:
   `SMART · NET+`.
2. Switch `/px:safe paranoid`. Token: `PARANOID · NET?` (the saved Allow all is
   retained but inactive).
3. Run `/px:net`. Expect a notice like:
   `PARANOID currently forces: NET? (Ask for all)` /
   `Your saved network policy: NET+ (Allow all)`.
4. Change the saved choice to **Deny all**, then switch back to
   `/px:safe smart`. Token: `SMART · NET` (the saved Deny all is restored).

## 4. Request behavior and approval prompts

Drive the `http`, `http_md`, and `web_search` tools (ask the agent to call them
explicitly). First set `/px:safe smart` and choose **Auto** in `/px:net`.

1. `SMART` + Auto (`ask-untrusted`):
   - `GET https://example.com` runs with no prompt.
   - `web_search` runs with no prompt.
   - `POST https://example.com` opens the safe-mode approval dialog. `Y` runs,
     `N` blocks, `Esc` blocks and steers.
2. `READER`: a `GET` now prompts too (Auto = `ask-all`).
3. `YOLO`: `GET` runs, `POST` is blocked with a reason and never prompts.
4. `PARANOID`: every valid request prompts, regardless of the saved policy.
5. Malformed requests never prompt: an invalid method (e.g. `GE T`) or URL
   (e.g. `ftp://example.com`) is blocked with an error.
6. MemoryFS read: after a result spills to memory, read it back with
   `memfs: { id }`. It must complete without a `perm:net` prompt even under
   `PARANOID` (paranoid still asks for the tool call, not for the network).

## 5. Fail-closed checks

These are covered by `bun test`; confirm by inspection rather than by breaking
the live session:

- permissions-core absent (extension disabled): requests block with a hub
  `no hub provider` reason.
- provider timeout or malformed answer: block.
- confirmation with no UI (non-interactive session): block.
- direct tool call with no `perm:tool` preflight: block (no authorization
  ticket).
