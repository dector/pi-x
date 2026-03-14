# Status Bar (Simple Architecture)

## Goal

Create one `status-bar` extension that is the only renderer.

It has a fixed layout with 3 sections:

- `left`
- `center`
- `right`

Each section is an ordered list of extension IDs.

Example initial layout:

```ts
{
  left: ["safe-mode", "switch-thinking"],
  center: [],
  right: [],
}
```

---

## How it works

### 1) Producer extensions send display content

Each producer extension sends what it wants to display, including formatting.

Suggested event:

- `status-bar:set`

Payload:

```ts
{
  id: string;      // extension id, e.g. "safe-mode" or "switch-thinking"
  content: string; // already formatted string
}
```

To clear output:

- `status-bar:clear`

Payload:

```ts
{
  id: string;
}
```

### 2) Status-bar extension renders only

`status-bar` stores latest content by `id`, then renders sections by configured order.

Rendering rules:

- Read IDs from section arrays (`left`, `center`, `right`)
- For each section, include only IDs with non-empty content
- Join items inside a section with ` | `
- Render three sections in layout order

That is all. No priorities, no TTL, no extra policies.

---

## Responsibilities

### Producer extensions

- Own their text and formatting
- Send updates when their state changes
- Clear when they no longer want to show anything

### Status-bar extension

- Own only layout and joining
- Never reinterpret producer formatting
- Never add business logic

---

## Recommendation

Start with:

```ts
left: ["safe-mode", "switch-thinking"]
center: []
right: []
```

Then migrate extensions one by one to emit `status-bar:set` / `status-bar:clear`.
