import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "prompt-stash";
const STASH_EVENT = "px:prompt-stash:stash";
const POP_EVENT = "px:prompt-stash:pop";
const LIST_EVENT = "px:prompt-stash:list";
const CLEAR_ALL_EVENT = "px:prompt-stash:clear-all";
const NEW_EVENT = "px:prompt-stash:new";
const STATUS_BAR_SET_EVENT = "px:status-bar:set";
const STATUS_BAR_CLEAR_EVENT = "px:status-bar:clear";
const STATUS_BAR_ID = "prompt-stash";

type PromptStashEvent =
	| { action: "stash"; stash: PromptStashItem }
	| { action: "pop"; id: string }
	| { action: "clear-all"; clearedIds: string[] };

type PromptStashItem = {
	id: string;
	text: string;
	createdAt: number;
	charCount: number;
};

type CustomEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

type NoticeType = "info" | "warning" | "error";

function trimEditorText(text: string): string {
	return text.trim();
}

function notify(ctx: ExtensionContext, message: string, type: NoticeType = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type !== "info") console.warn(`[prompt-stash] ${message}`);
}

function createStash(text: string): PromptStashItem {
	return {
		id: randomUUID(),
		text,
		createdAt: Date.now(),
		charCount: text.length,
	};
}

function appendEvent(pi: ExtensionAPI, event: PromptStashEvent): void {
	pi.appendEntry<PromptStashEvent>(CUSTOM_TYPE, event);
}

function formatPreview(text: string): string {
	const firstLine = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	const collapsed = (firstLine || "(blank)").replace(/\s+/g, " ");
	return collapsed.length <= 72 ? collapsed : `${collapsed.slice(0, 69)}...`;
}

function formatAge(createdAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatCount(count: number): string {
	return `${count} char${count === 1 ? "" : "s"}`;
}

function formatStashLine(stash: PromptStashItem, newestIndex: number): string {
	return `#${newestIndex} ${formatPreview(stash.text)} — ${formatAge(stash.createdAt)}, ${formatCount(stash.charCount)}`;
}

function isPromptStashItem(value: unknown): value is PromptStashItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<PromptStashItem>;
	return (
		typeof item.id === "string" &&
		typeof item.text === "string" &&
		typeof item.createdAt === "number" &&
		typeof item.charCount === "number"
	);
}

function isPromptStashEvent(value: unknown): value is PromptStashEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<PromptStashEvent>;
	if (event.action === "stash") return isPromptStashItem((event as { stash?: unknown }).stash);
	if (event.action === "pop") return typeof (event as { id?: unknown }).id === "string";
	if (event.action === "clear-all") {
		const ids = (event as { clearedIds?: unknown }).clearedIds;
		return Array.isArray(ids) && ids.every((id) => typeof id === "string");
	}
	return false;
}

function newestFirst(stashes: PromptStashItem[]): PromptStashItem[] {
	return [...stashes].reverse();
}

export default function promptStashExtension(pi: ExtensionAPI): void {
	let stashes: PromptStashItem[] = [];
	let activeContext: ExtensionContext | undefined;
	const appliedTransfers = new Set<string>();

	const publishStatus = (ctx: ExtensionContext): void => {
		if (stashes.length === 0) {
			pi.events.emit(STATUS_BAR_CLEAR_EVENT, { id: STATUS_BAR_ID });
			return;
		}
		const content = `\x1b[38;2;210;153;34m󱊖 ${stashes.length}\x1b[39m`;
		pi.events.emit(STATUS_BAR_SET_EVENT, {
			id: STATUS_BAR_ID,
			content,
		});
	};

	const rebuildStashes = (ctx: ExtensionContext): void => {
		const rebuilt: PromptStashItem[] = [];
		// Stashes are session-wide, not part of a branch's conversation state.
		const entries = ctx.sessionManager.getEntries() as CustomEntry[];

		for (const entry of entries) {
			if (entry?.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
			if (!isPromptStashEvent(entry.data)) continue;

			if (entry.data.action === "stash") {
				const item = entry.data.stash;
				if (!rebuilt.some((stash) => stash.id === item.id)) rebuilt.push(item);
			} else if (entry.data.action === "pop") {
				const id = entry.data.id;
				const index = rebuilt.findIndex((stash) => stash.id === id);
				if (index !== -1) rebuilt.splice(index, 1);
			} else if (entry.data.action === "clear-all") {
				const clearedIds = new Set(entry.data.clearedIds);
				for (let index = rebuilt.length - 1; index >= 0; index--) {
					if (clearedIds.has(rebuilt[index]!.id)) rebuilt.splice(index, 1);
				}
			}
		}

		stashes = rebuilt;
		publishStatus(ctx);
	};

	const saveStash = (ctx: ExtensionContext, text: string): PromptStashItem => {
		const stash = createStash(text);
		stashes.push(stash);
		appendEvent(pi, { action: "stash", stash });
		publishStatus(ctx);
		return stash;
	};

	const stashCurrentEditor = async (ctx: ExtensionContext): Promise<PromptStashItem | undefined> => {
		const text = ctx.ui.getEditorText();
		if (!trimEditorText(text)) {
			notify(ctx, "prompt-stash: editor is empty", "warning");
			return undefined;
		}

		const stash = saveStash(ctx, text);
		ctx.ui.setEditorText("");
		notify(ctx, `prompt-stash: stashed ${formatCount(stash.charCount)} (${formatPreview(stash.text)})`, "info");
		return stash;
	};

	const createNewStash = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			notify(ctx, "prompt-stash: creating a stash requires an interactive session", "warning");
			return;
		}
		const text = await ctx.ui.editor("prompt-stash: new prompt", "");
		if (text === undefined || !trimEditorText(text)) return;
		const stash = saveStash(ctx, text);
		notify(ctx, `prompt-stash: stashed ${formatCount(stash.charCount)} (${formatPreview(stash.text)})`, "info");
	};

	const removeStash = (ctx: ExtensionContext, stash: PromptStashItem): void => {
		const index = stashes.findIndex((item) => item.id === stash.id);
		if (index !== -1) stashes.splice(index, 1);
		appendEvent(pi, { action: "pop", id: stash.id });
		publishStatus(ctx);
	};

	const restoreStash = async (ctx: ExtensionContext, stash: PromptStashItem): Promise<void> => {
		const current = ctx.ui.getEditorText();
		if (trimEditorText(current)) {
			if (!ctx.hasUI) {
				notify(ctx, "prompt-stash: editor is non-empty; refusing to replace without UI confirmation", "warning");
				return;
			}

			const choice = await ctx.ui.select("prompt-stash: editor is not empty", [
				"Stash current and restore",
				"Replace current without stashing",
				"Cancel",
			]);

			if (choice === undefined || choice === "Cancel") return;
			if (choice === "Stash current and restore") {
				const currentStash = createStash(current);
				stashes.push(currentStash);
				appendEvent(pi, { action: "stash", stash: currentStash });
				publishStatus(ctx);
			}
		}

		ctx.ui.setEditorText(stash.text);
		removeStash(ctx, stash);
		notify(ctx, `prompt-stash: restored ${formatCount(stash.charCount)} (${formatPreview(stash.text)})`, "info");
	};

	const popNewest = async (ctx: ExtensionContext): Promise<void> => {
		const stash = stashes.at(-1);
		if (!stash) {
			notify(ctx, "prompt-stash: no stashes", "warning");
			return;
		}
		await restoreStash(ctx, stash);
	};

	const unsubscribeRenewRequest = pi.events.on("px:renew:settings:request", (payload) => {
		if (!activeContext || !payload || typeof payload !== "object") return;
		const request = payload as { id?: unknown; sourceSessionId?: unknown; cwd?: unknown };
		if (typeof request.id !== "string" || request.sourceSessionId !== activeContext.sessionManager.getSessionId() || request.cwd !== activeContext.cwd) return;
		rebuildStashes(activeContext);
		pi.events.emit("px:renew:settings:response", {
			id: request.id, owner: CUSTOM_TYPE, sourceSessionId: request.sourceSessionId,
			cwd: request.cwd, state: { stashes: stashes.map((stash) => ({ ...stash })) },
		});
	});
	const unsubscribeRenewApply = pi.events.on("px:renew:settings:apply", (payload) => {
		if (!activeContext || !payload || typeof payload !== "object") return;
		const request = payload as { transferId?: unknown; owner?: unknown; targetSessionId?: unknown; cwd?: unknown; state?: unknown };
		if (typeof request.transferId !== "string" || request.owner !== CUSTOM_TYPE || request.targetSessionId !== activeContext.sessionManager.getSessionId() || request.cwd !== activeContext.cwd) return;
		const incoming = (request.state as { stashes?: unknown } | null)?.stashes;
		if (!Array.isArray(incoming) || !incoming.every(isPromptStashItem)) return;
		if (!appliedTransfers.has(request.transferId)) {
			for (const stash of incoming) {
				if (stashes.some((item) => item.id === stash.id)) continue;
				appendEvent(pi, { action: "stash", stash: { ...stash } });
				stashes.push({ ...stash });
			}
			appliedTransfers.add(request.transferId);
			publishStatus(activeContext);
		}
		pi.events.emit("px:renew:settings:ack", {
			transferId: request.transferId, owner: CUSTOM_TYPE,
			targetSessionId: request.targetSessionId, cwd: request.cwd,
		});
	});

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		appliedTransfers.clear();
		rebuildStashes(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		activeContext = ctx;
		rebuildStashes(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubscribeRenewRequest();
		unsubscribeRenewApply();
		activeContext = undefined;
		appliedTransfers.clear();
		pi.events.emit(STATUS_BAR_CLEAR_EVENT, { id: STATUS_BAR_ID });
	});

	pi.registerCommand("px:prompt-stash.stash", {
		description: "Save current editor draft and clear the editor",
		handler: async (_args, ctx) => {
			await stashCurrentEditor(ctx);
		},
	});

	pi.registerCommand("px:prompt-stash.new", {
		description: "Compose a prompt and save it directly to the stash",
		handler: async (_args, ctx) => {
			await createNewStash(ctx);
		},
	});

	pi.registerCommand("px:prompt-stash.pop", {
		description: "Restore and remove the newest prompt stash",
		handler: async (_args, ctx) => {
			await popNewest(ctx);
		},
	});

	const listStashes = async (ctx: ExtensionContext): Promise<void> => {
		if (stashes.length === 0) {
			notify(ctx, "prompt-stash: no stashes", "info");
			return;
		}

		const ordered = newestFirst(stashes);
		const lines = ordered.map((stash, index) => formatStashLine(stash, index + 1));
		if (ctx.hasUI) {
			const choice = await ctx.ui.select(`prompt-stash: ${stashes.length} stash${stashes.length === 1 ? "" : "es"}`, lines);
			if (choice === undefined) return;
			const index = lines.indexOf(choice);
			if (index === -1) return;
			await restoreStash(ctx, ordered[index]!);
		} else {
			console.log(lines.join("\n"));
		}
	};

	pi.registerCommand("px:prompt-stash.list", {
		description: "List prompt stashes newest-first; in UI, select one to restore it",
		handler: async (_args, ctx) => {
			await listStashes(ctx);
		},
	});

	const clearAll = async (ctx: ExtensionContext): Promise<void> => {
		if (stashes.length === 0) {
			notify(ctx, "prompt-stash: no stashes", "info");
			return;
		}
		if (!ctx.hasUI) {
			notify(ctx, "prompt-stash: clear-all requires interactive confirmation", "warning");
			return;
		}

		const count = stashes.length;
		const ok = await ctx.ui.confirm("prompt-stash: clear all?", `Delete ${count} stash${count === 1 ? "" : "es"}?`);
		if (!ok) return;

		const clearedIds = stashes.map((stash) => stash.id);
		appendEvent(pi, { action: "clear-all", clearedIds });
		stashes = [];
		publishStatus(ctx);
		notify(ctx, `prompt-stash: cleared ${count} stash${count === 1 ? "" : "es"}`, "info");
	};

	pi.registerCommand("px:prompt-stash.clear-all", {
		description: "Delete every prompt stash",
		handler: async (_args, ctx) => {
			await clearAll(ctx);
		},
	});

	const withCtx = async (payload: unknown, fn: (ctx: ExtensionContext) => Promise<unknown>): Promise<void> => {
		if (!payload || typeof payload !== "object") return;
		const maybeCtx = (payload as { ctx?: ExtensionContext }).ctx;
		if (!maybeCtx) return;
		await fn(maybeCtx);
	};

	pi.events.on(STASH_EVENT, (payload) => void withCtx(payload, stashCurrentEditor));
	pi.events.on(NEW_EVENT, (payload) => void withCtx(payload, createNewStash));
	pi.events.on(POP_EVENT, (payload) => void withCtx(payload, popNewest));
	pi.events.on(LIST_EVENT, (payload) => void withCtx(payload, listStashes));
	pi.events.on(CLEAR_ALL_EVENT, (payload) => void withCtx(payload, clearAll));

	pi.registerEntryRenderer<PromptStashEvent>(CUSTOM_TYPE, (entry, _options, theme) => {
		const event = entry.data;
		let message = "prompt-stash: unknown event";
		if (event?.action === "stash") {
			message = `prompt-stash: stashed ${formatCount(event.stash.charCount)}`;
		} else if (event?.action === "pop") {
			message = `prompt-stash: popped ${event.id.slice(0, 8)}`;
		} else if (event?.action === "clear-all") {
			message = `prompt-stash: cleared ${event.clearedIds.length}`;
		}

		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", message), 0, 0));
		return box;
	});
}
