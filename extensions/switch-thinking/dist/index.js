// extensions/switch-thinking/index.ts
import { Key as Key2 } from "@mariozechner/pi-tui";

// extensions/switch-thinking/state.ts
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var THINKING_MODES = ["off", "minimal", "low", "medium", "high", "xhigh"];
var GLOBAL_STATE_PATH = join(homedir(), ".pi", "agent", "space.dector-switch-thinking.json");
var DEFAULT_STATE = {
  version: 1,
  favorites: []
};
function isThinkingMode(value) {
  return typeof value === "string" && THINKING_MODES.includes(value);
}
function toErrorMessage(error) {
  if (error instanceof Error)
    return error.message;
  return String(error);
}
function uniqueModes(modes) {
  const seen = new Set;
  const out = [];
  for (const mode of modes) {
    if (seen.has(mode))
      continue;
    seen.add(mode);
    out.push(mode);
  }
  return out;
}
function sanitizeState(input) {
  if (!input || typeof input !== "object")
    return { ...DEFAULT_STATE };
  const raw = input;
  const favorites = Array.isArray(raw.favorites) ? uniqueModes(raw.favorites.filter((value) => isThinkingMode(value))) : [];
  return {
    version: 1,
    favorites
  };
}
function loadGlobalState() {
  try {
    const content = readFileSync(GLOBAL_STATE_PATH, "utf-8");
    const parsed = JSON.parse(content);
    return { state: sanitizeState(parsed) };
  } catch (error) {
    const nodeError = error;
    if (nodeError?.code === "ENOENT") {
      return { state: { ...DEFAULT_STATE } };
    }
    return {
      state: { ...DEFAULT_STATE },
      error: `Failed to load ${GLOBAL_STATE_PATH}: ${toErrorMessage(error)}`
    };
  }
}
function saveGlobalState(state) {
  let tempPath = "";
  try {
    const sanitized = sanitizeState(state);
    mkdirSync(dirname(GLOBAL_STATE_PATH), { recursive: true });
    tempPath = `${GLOBAL_STATE_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(tempPath, `${JSON.stringify(sanitized, null, 2)}
`, "utf-8");
    renameSync(tempPath, GLOBAL_STATE_PATH);
    return { ok: true };
  } catch (error) {
    if (tempPath) {
      try {
        rmSync(tempPath, { force: true });
      } catch {}
    }
    return {
      ok: false,
      error: `Failed to save ${GLOBAL_STATE_PATH}: ${toErrorMessage(error)}`
    };
  }
}

// extensions/switch-thinking/ui.ts
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text } from "@mariozechner/pi-tui";
function modeLabel(mode, favoriteSet) {
  return `${favoriteSet.has(mode) ? "★" : " "} ${mode}`;
}
function modeDescription(mode, currentMode, favoriteSet) {
  const tags = [];
  if (mode === currentMode)
    tags.push("current");
  if (favoriteSet.has(mode))
    tags.push("favorite");
  return tags.length > 0 ? tags.join(" • ") : undefined;
}
async function showThinkingPicker(ctx, options) {
  if (!ctx.hasUI)
    return null;
  if (options.availableModes.length === 0)
    return null;
  const result = await ctx.ui.custom((tui, theme, _kb, done) => {
    let selectedValue = options.getCurrentMode();
    if (!options.availableModes.includes(selectedValue)) {
      selectedValue = options.availableModes[0];
    }
    const createView = () => {
      const currentMode = options.getCurrentMode();
      const favoriteSet = new Set(options.getFavorites());
      const items = options.availableModes.map((mode) => ({
        value: mode,
        label: modeLabel(mode, favoriteSet),
        description: modeDescription(mode, currentMode, favoriteSet)
      }));
      const container = new Container;
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Switch Thinking Mode"))));
      const list = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text)
      });
      const selectedIndex = items.findIndex((item) => item.value === selectedValue);
      list.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
      list.onSelectionChange = (item) => {
        selectedValue = item.value;
      };
      list.onSelect = (item) => {
        const mode = item.value;
        options.onSelect(mode);
        done(mode);
      };
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓/j k navigate • enter select • space favorite • esc cancel")));
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      return { container, list, items };
    };
    let view = createView();
    const moveSelection = (delta) => {
      if (view.items.length === 0)
        return;
      const currentIndex = Math.max(0, view.items.findIndex((item) => item.value === selectedValue));
      const nextIndex = Math.max(0, Math.min(view.items.length - 1, currentIndex + delta));
      view.list.setSelectedIndex(nextIndex);
      selectedValue = view.items[nextIndex].value;
      tui.requestRender();
    };
    return {
      render(width) {
        return view.container.render(width);
      },
      invalidate() {
        view.container.invalidate();
      },
      handleInput(data) {
        if (matchesKey(data, Key.space) || data === " ") {
          const selected2 = view.list.getSelectedItem();
          if (!selected2)
            return;
          const mode = selected2.value;
          options.onToggleFavorite(mode);
          selectedValue = mode;
          view = createView();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "j") || data === "j") {
          moveSelection(1);
          return;
        }
        if (matchesKey(data, "k") || data === "k") {
          moveSelection(-1);
          return;
        }
        view.list.handleInput(data);
        const selected = view.list.getSelectedItem();
        if (selected)
          selectedValue = selected.value;
        tui.requestRender();
      }
    };
  });
  return result ?? null;
}

// extensions/switch-thinking/index.ts
function asModeSet(modes) {
  return new Set(modes);
}
function orderedByCanonical(modes) {
  const set = asModeSet(modes);
  return THINKING_MODES.filter((mode) => set.has(mode));
}
function uniqueModes2(modes) {
  return orderedByCanonical(modes);
}
function isReasoningDisabled(model) {
  return model?.reasoning === false;
}
function getAvailableModes(model) {
  if (isReasoningDisabled(model))
    return ["off"];
  return [...THINKING_MODES];
}
function notify(ctx, message, type = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  if (type !== "info")
    console.warn(`[switch-thinking] ${message}`);
}
function switchThinkingExtension(pi) {
  let favorites = [];
  let pickerOpen = false;
  const persistFavorites = (ctx) => {
    const result = saveGlobalState({ version: 1, favorites });
    if (!result.ok) {
      notify(ctx, result.error, "error");
      return false;
    }
    return true;
  };
  const updateStatus = (ctx) => {
    if (!ctx.hasUI)
      return;
    if (favorites.length === 0) {
      ctx.ui.setStatus("switch-thinking", undefined);
      return;
    }
    ctx.ui.setStatus("switch-thinking", ctx.ui.theme.fg("accent", `\uD83E\uDDE0 fav:${favorites.join(",")}`));
  };
  const toggleFavorite = (mode, ctx) => {
    const alreadyFavorite = favorites.includes(mode);
    if (alreadyFavorite) {
      favorites = favorites.filter((favorite) => favorite !== mode);
    } else {
      favorites = uniqueModes2([...favorites, mode]);
    }
    persistFavorites(ctx);
    updateStatus(ctx);
  };
  const applyThinkingMode = (mode, ctx) => {
    const before = pi.getThinkingLevel();
    pi.setThinkingLevel(mode);
    const applied = pi.getThinkingLevel();
    if (applied !== mode) {
      notify(ctx, `Requested thinking mode '${mode}' was clamped to '${applied}'.`, "warning");
      return;
    }
    if (before !== applied) {
      notify(ctx, `Thinking mode: ${applied}`, "info");
    }
  };
  const getAvailableFavorites = (ctx) => {
    const available = new Set(getAvailableModes(ctx.model));
    return orderedByCanonical(favorites.filter((mode) => available.has(mode)));
  };
  const cycleFavorites = (ctx) => {
    if (pickerOpen)
      return;
    if (favorites.length === 0) {
      notify(ctx, "No favorite thinking modes set. Use Ctrl+Alt+T and Space to add favorites.", "warning");
      return;
    }
    const availableFavorites = getAvailableFavorites(ctx);
    if (availableFavorites.length === 0) {
      notify(ctx, "All favorite thinking modes are unavailable for the current model. Try switching model or add 'off'.", "warning");
      return;
    }
    const current = pi.getThinkingLevel();
    let target;
    if (availableFavorites.length === 1) {
      target = availableFavorites[0];
    } else {
      const currentIndex = availableFavorites.indexOf(current);
      target = currentIndex === -1 ? availableFavorites[0] : availableFavorites[(currentIndex + 1) % availableFavorites.length];
    }
    applyThinkingMode(target, ctx);
  };
  const openPicker = async (ctx) => {
    if (!ctx.hasUI)
      return;
    if (pickerOpen)
      return;
    pickerOpen = true;
    try {
      await showThinkingPicker(ctx, {
        availableModes: getAvailableModes(ctx.model),
        getCurrentMode: () => pi.getThinkingLevel(),
        getFavorites: () => favorites,
        onSelect: (mode) => {
          applyThinkingMode(mode, ctx);
        },
        onToggleFavorite: (mode) => {
          toggleFavorite(mode, ctx);
        }
      });
    } finally {
      pickerOpen = false;
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadGlobalState();
    favorites = uniqueModes2(loaded.state.favorites);
    if (loaded.error) {
      notify(ctx, `${loaded.error}. Using empty favorites for this session.`, "warning");
    }
    updateStatus(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
    if (favorites.length === 0)
      return;
    if (getAvailableFavorites(ctx).length > 0)
      return;
    notify(ctx, `No favorite thinking modes are available on this model. Favorites file: ${GLOBAL_STATE_PATH}`, "warning");
  });
  pi.registerShortcut(Key2.ctrlAlt("t"), {
    description: "Open thinking mode picker",
    handler: async (ctx) => {
      await openPicker(ctx);
    }
  });
  pi.registerShortcut(Key2.ctrl("t"), {
    description: "Cycle favorite thinking modes",
    handler: async (ctx) => {
      cycleFavorites(ctx);
    }
  });
}
export {
  switchThinkingExtension as default
};
