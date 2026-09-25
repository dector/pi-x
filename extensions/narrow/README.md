# narrow

Keeps pi inside a centered reading column so a wide monitor does not stretch
every line across the screen.

```text
/px:narrow            toggle the reading column
/px:narrow on         enable it (default width 100)
/px:narrow off        disable it, back to full width
/px:narrow set 100           set the width and enable it
/px:narrow set 100/-50      set the width, slide the column left, and enable it
/px:narrow on 100     same as `set 100`
/px:narrow bias       show the current bias
/px:narrow bias -50   slide the column left, -100 is flush against the left edge
/px:narrow bias 100   slide it right, 0 (the default) is centered
/px:narrow status     show the current state
```

`set` takes an optional bias after a slash: `set 100/-50`. Leave it off and the
current bias is kept, so `set 120` only changes the width.

The width, the bias and the on/off state are global and persist in
`~/.pi/agent/space.dector-narrow.json`, so the choice applies from the first
frame of the next session. `PI_NARROW_STATE_PATH` overrides the location.

Defaults are `on` at 100 columns, centered. On a screen that is already 100
columns wide or narrower there is no margin at all: pi is told the real width
and its output is byte for byte what it would have been without this extension.

## Bias

`bias` is a percentage of the *leftover* space, not of the screen. It says how
far the column is allowed to slide away from the center:

```text
left margin = leftover / 2 + leftover × bias / 200
```

| bias | where the column sits |
|---|---|
| `-100` | left margin 0, flush against the left edge |
| `-50` | halfway between flush left and centered |
| `0` (default) | centered |
| `+50` | halfway between centered and flush right |
| `+100` | flush against the right edge |

For a 200 column screen with a 100 column reading column there are 100 cells of
slack, so `bias -50` leaves 25 on the left and 75 on the right. Values outside
`-100..100` are rejected by the parser; the computed margin is clamped so the
column can never slide off screen. The bias is kept when you change the width
with `set 120` (no bias half) or toggle narrow mode, and `bias 0` puts it back
to centered. A bias is inert when narrow mode is off, or when the screen is not
wider than the reading column.

## How it works

pi reads its render width from `process.stdout.columns` and nothing else, and
addresses columns with a small, fixed set of escape sequences. So:

1. **Narrow** — `process.stdout.columns` is redefined to report
   `min(100, realWidth)`. The whole interface wraps there: transcript, editor,
   footer, dialogs, markdown, code blocks.
2. **Place** — `process.stdout.write` is wrapped and every column-addressing
   sequence is shifted right by the left margin:
   `\r`, `\r\n`, `ESC [ r ; c H`, `ESC [ c G`, `ESC [ F`, `ESC [ E`.
   Styling, erase-line, erase-display, vertical moves, OSC 8 links and image
   payloads are passed through untouched.
3. **Mouse** — `process.stdin` SGR reports (`ESC [ < b ; x ; y M`) are shifted
   left by the same amount, so clicks, drags, wheel and the scrollbar land on
   the cell the user aimed at.
4. **Repaint** — after a change, a `resize` event is emitted on stdout, which is
   what pi listens to. Width changes repaint in one pass. A change that moves
   only the margin (a bias change, or a terminal resize that keeps the same
   width) needs two passes: full width, then narrow, because pi repaints
   everything only when the width it sees changes.

This deliberately avoids pi internals: it keeps working across
regular/fullscreen mode switches, `/clear`, theme changes, and pi recreating its
renderer. A `/reload` shares the same patch instead of stacking a second one.

## Caveats

- **pi internals.** The output transform matches the escape sequences pi
  currently emits. A future pi version that adds another column-addressing
  sequence would render slightly off; `/px:narrow off` is always a clean escape
  hatch.
- **Terminal resize** while narrow is on costs one full-width frame before the
  narrow frame lands. Same for a `bias` change, since it moves the margin
  without changing the width.
- **Inline images** (kitty/iterm2) are placed relative to the cursor, which the
  shift moves, so they land in the column, but they are not independently
  verified.
- **`interactive-bash`** writes its own status lines straight to stdout without
  a carriage return, so those few lines are not indented.

## Tests

```bash
bun test extensions/narrow
```
