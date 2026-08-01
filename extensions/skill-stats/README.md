# skill-stats

Tracks skills read during the current pi session and publishes a first-line status-bar item:

```text
SKILLS: n/m
```

- `n` is the number of unique successfully-read `SKILL.md` files in the current session.
- `m` is the number of loaded/known skills reported by pi for the current session and refreshed before each agent run.

Requires [`status-bar`](../status-bar/README.md). If `status-bar` does not answer the extension availability ping, `skill-stats` warns once per session.

## Status-bar integration

Publishes:

```ts
pi.events.emit("status-bar:first-line:set", {
  id: "skill-stats",
  content: "SKILLS: 0/0",
  section: "right",
});
```

On shutdown it clears the same id with `status-bar:first-line:clear`.

## Commands

- `/skill-stats-debug` — show the denominator and counted absolute `SKILL.md` paths.
