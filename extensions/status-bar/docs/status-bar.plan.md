# Status Bar Plan (Simple)

## Default implementation instructions (for any agent)

Apply these by default unless explicitly overridden in-task:

- After each milestone/code change, install this extension on the current machine for manual testing:
  - `~/.pi/agent/extensions/status-bar/`
- Keep manual testing straightforward:
  - run `/reload`
  - verify status-bar output in a live session
- While centralized producer migration is incomplete, keep layout visibly rendered so structure is easy to inspect:
  - always render three sections (`left`, `center`, `right`) as bracketed blocks
  - render empty sections as `[]`
  - use section delimiter ` · ` (dot in the center)
- Keep producer-item join rule inside sections as the frozen contract value: ` | `

## Target design

One `status-bar` extension renders 3 sections:

- `left`
- `center`
- `right`

Initial order:

```ts
left: ["safe-mode", "switch-thinking"]
center: []
right: []
```

Producer extensions send their own already-formatted content.

Status-bar only places outputs in the configured order and joins with ` | `.

---

## Milestones

### M1 — Freeze simple contract

Define and document:

- Layout config shape (`left`, `center`, `right` arrays of IDs)
- Events:
  - `status-bar:set` with `{ id, content }`
  - `status-bar:clear` with `{ id }`
- Join rule: ` | ` between outputs

**Done when:** idea doc is approved with this exact scope.

---

### M2 — Prepare status-bar extension skeleton (implemented)

Plan internal responsibilities:

- In-memory map: `id -> content`
- Read configured section order
- Build section strings by order
- Skip missing/empty content
- Render left/center/right

**Done when:** implementation notes are clear enough to code directly.

---

### M3 — Migration mapping for existing extensions

Map current extensions:

- `safe-mode` -> `id: "safe-mode"`
- `switch-thinking` -> `id: "switch-thinking"`

For each:

- What string it sends as `content`
- When it sends updates
- When it sends clear

**Done when:** both mappings are documented and reviewed.

---

### M4 — Implement status-bar extension

(Implementation milestone, later)

- Add status-bar extension
- Add event listeners (`set`, `clear`)
- Add rendering for left/center/right
- Add ` | ` joining

**Done when:** status-bar can show data from test events.

---

### M5 — Migrate `safe-mode`

- Stop direct status rendering from `safe-mode`
- Emit `status-bar:set` / `status-bar:clear`

**Done when:** `safe-mode` appears via status-bar only.

---

### M6 — Migrate `switch-thinking`

- Stop direct status rendering from `switch-thinking` extension
- Emit `status-bar:set` / `status-bar:clear`

**Done when:** `switch-thinking` appears via status-bar only.

---

### M7 — Cleanup

- Remove old direct status calls from migrated extensions
- Update extension READMEs with the new pattern

**Done when:** centralized status-bar pattern is documented and used.

---

## Notes

- Keep this intentionally simple.
- No priorities, TTL, sorting rules, or complex formatting policies.
- Producers fully control their text/formatting; status-bar only arranges and joins.
