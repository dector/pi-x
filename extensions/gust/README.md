# gust (pi extension)

TUI prototype for browsing [Gust](https://github.com/dector/gust) comment
threads from inside pi.

This first cut is **layout only**: the threads come from [`fixtures.ts`](fixtures.ts)
(fake comments on the pi-x website). The next step is to replace the fixtures
with a real `gust ctl comments` client behind the same `Thread` type.

## Command

- `/px:gust` — open the thread browser.

## Layout

```
──────────────────────────────────────────────────────────────
 Gust comments  pi-x website · fake data        filter: all
 ✎ 1  ○ 2  ◐ 1  ● 2  ✓ 1
──────────────────────────────────────────────────────────────
 ▌ ○ /docs/install  The install snippet still…  │ /docs/install
   ○ /extensions/subagent  This paragraph…      │ submitted · id 8f21a4
   ◐ /extensions  On narrow screens the…        │ created 2026-09-26 14:02
   ● /  Hero subtitle reads…                    │
   …                                            │ ▌ human  14:02
──────────────────────────────────────────────────────────────
 ↑↓ select · shift+j/k scroll · enter/r reply · …
```

The left pane lists unfinished threads (state glyph + page path + text
preview); the right pane shows the selected thread's meta, locator, captured
HTML, and message timeline. On terminals narrower than 84 columns it collapses
to a single pane: `enter` opens a thread, `esc` goes back.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Move the selection |
| `shift+j` / `shift+k` | Scroll the thread pane |
| `enter` / `r` | Reply to the selected thread (as `human` by default) |
| `tab` | In the reply box: toggle the reply author (`human` / `agent`) |
| `s` | Agent reply and mark the thread `review` |
| `x` | Resolve the thread (`y`/`n` confirm) |
| `w` | Dispatch a simulated worker (2.8 s, then `review`) |
| `f` | Cycle the state filter (all → open → submitted → …) |
| `esc` | Close, go back, or cancel |

## State glyphs

| Glyph | State | Meaning |
| --- | --- | --- |
| `✎` | `created` | Draft, not submitted — not work yet |
| `○` | `submitted` | Waiting for an agent |
| `◐` | `seen` | Claimed by an agent |
| `●` | `review` | Agent replied, waiting for the human |
| `✓` | `done` | Resolved by the human |

## Notes / next steps

- Replies typed in the TUI default to `human` (matching `gust ctl comments
  reply <id> <text> --human`); `tab` switches to `agent` for the same command
  without the flag. `s` (review) is always an agent action.
- A human reply to a `review` thread reopens it as `submitted` (fresh batch),
  mirroring Gust, so the next worker cycle picks it up.
- `x` (resolve) is the human action; a real worker must never call it.
- `w` fakes the eventual async worker: spawn a `pi` subprocess per thread, post
  `review` on completion, and keep listening until the human resolves the
  thread or replies (which reopens it as `submitted`).
- Files are split so the real client can drop in: `types.ts` (domain),
  `fixtures.ts` (fake data), `dialog.ts` (TUI), `index.ts` (registration).
