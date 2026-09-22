# review-level

Session-scoped recommended review effort for pi agents.

Use `/px:review` to open the picker, or set a level directly:

```text
/px:review auto
/px:review off
/px:review minimal
/px:review normal
/px:review high
```

## Levels

| Level | Icon | Agent guidance |
| --- | --- | --- |
| `auto` | `󰈈` | No user hint. The agent decides whether and how much to review. |
| `off` | `󰛑` | Prefer the first working implementation and normal tests. Avoid a separate review pass except for obvious critical correctness or security risk. |
| `minimal` | `󱀧` | Review only when clearly warranted. Passing relevant tests is sufficient and small non-critical issues are acceptable. |
| `normal` | `󰛐` | Use one proportionate review pass for most non-trivial changes. |
| `high` | `󰡬` | Produce polished work. Review and resolve critical and important findings, repeating when needed. |

`auto` is the default. Explicit levels add a structured `review_recommendation`
section to the agent system prompt before each run. This is a recommendation,
not an execution gate: correctness and safety requirements still apply.

The selected level is persisted in the current session branch and restored on
resume or tree navigation. New sessions start at `auto`.

When `status-bar` is installed, the selected eye icon appears in the editor's
top-left label immediately after model effort (`<effort> · <eye>`) for explicit
levels. The separator and icon use the frame-border purple. Auto is hidden, though
its icon mapping remains available in code for possible reuse.
