import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, isAbsolute, resolve } from "node:path";

const EXTENSION_ID = "skill-stats";
const STATUS_BAR_FIRST_LINE_SET_EVENT = "status-bar:first-line:set";
const STATUS_BAR_FIRST_LINE_CLEAR_EVENT = "status-bar:first-line:clear";
const STATUS_BAR_PING_EVENT = "status-bar:ping";
const STATUS_BAR_PONG_EVENT = "status-bar:pong";
const STATUS_BAR_WARNING_DELAY_MS = 500;
const ANSI_RESET = "\u001b[0m";
const ANSI_GRAY = "\u001b[90m";

interface StatusBarPongPayload {
	id?: unknown;
}

interface ReadToolInput {
	path?: unknown;
}

function resolveReadPath(ctx: ExtensionContext, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path);
}

function getReadToolPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const maybe = input as ReadToolInput;
	return typeof maybe.path === "string" && maybe.path.trim().length > 0 ? maybe.path : undefined;
}

function getLoadedSkillCount(systemPromptOptions: unknown): number {
	if (!systemPromptOptions || typeof systemPromptOptions !== "object") return 0;
	const skills = (systemPromptOptions as { skills?: unknown }).skills;
	return Array.isArray(skills) ? skills.length : 0;
}

function getContextLoadedSkillCount(ctx: ExtensionContext): number {
	const maybe = ctx as ExtensionContext & { getSystemPromptOptions?: () => unknown };
	if (typeof maybe.getSystemPromptOptions !== "function") return 0;
	return getLoadedSkillCount(maybe.getSystemPromptOptions());
}

export default function skillStatsExtension(pi: ExtensionAPI): void {
	const readSkillPaths = new Set<string>();
	let loadedSkillCount = 0;
	let statusBarAvailable = false;
	let warnedMissingStatusBar = false;
	let warningTimer: ReturnType<typeof setTimeout> | undefined;
	let activeSessionContext: ExtensionContext | undefined;

	const content = (): string => {
		const text = `SKILLS: ${readSkillPaths.size}/${loadedSkillCount}`;
		return activeSessionContext?.hasUI ? `${ANSI_GRAY}${text}${ANSI_RESET}` : text;
	};

	const publish = (): void => {
		pi.events.emit(STATUS_BAR_FIRST_LINE_SET_EVENT, {
			id: EXTENSION_ID,
			content: content(),
			section: "right",
		});
	};

	const clearWarningTimer = (): void => {
		if (warningTimer === undefined) return;
		clearTimeout(warningTimer);
		warningTimer = undefined;
	};

	const warnMissingStatusBar = (): void => {
		warningTimer = undefined;
		if (statusBarAvailable || warnedMissingStatusBar) return;
		warnedMissingStatusBar = true;
		if (activeSessionContext?.hasUI) {
			activeSessionContext.ui.notify("skill-stats requires status-bar extension", "warning");
		}
	};

	const resetSessionState = (ctx: ExtensionContext): void => {
		readSkillPaths.clear();
		loadedSkillCount = 0;
		statusBarAvailable = false;
		warnedMissingStatusBar = false;
		activeSessionContext = ctx;
		clearWarningTimer();
	};

	pi.events.on(STATUS_BAR_PONG_EVENT, (payload) => {
		const maybe = payload as StatusBarPongPayload | undefined;
		if (maybe?.id !== EXTENSION_ID) return;
		statusBarAvailable = true;
		clearWarningTimer();
	});

	pi.on("session_start", async (_event, ctx) => {
		resetSessionState(ctx);
		loadedSkillCount = getContextLoadedSkillCount(ctx);
		publish();
		warningTimer = setTimeout(warnMissingStatusBar, STATUS_BAR_WARNING_DELAY_MS);
		pi.events.emit(STATUS_BAR_PING_EVENT, { id: EXTENSION_ID });
	});

	pi.on("before_agent_start", async (event, ctx) => {
		activeSessionContext = ctx;
		const nextLoadedSkillCount = getLoadedSkillCount(event.systemPromptOptions);
		if (nextLoadedSkillCount === loadedSkillCount) return;
		loadedSkillCount = nextLoadedSkillCount;
		publish();
	});

	pi.on("tool_result", async (event, ctx) => {
		activeSessionContext = ctx;
		if (event.toolName !== "read") return;
		if (event.isError) return;

		const readPath = getReadToolPath(event.input);
		if (!readPath) return;

		const absolutePath = resolveReadPath(ctx, readPath);
		if (basename(absolutePath) !== "SKILL.md") return;

		const beforeSize = readSkillPaths.size;
		readSkillPaths.add(absolutePath);
		if (readSkillPaths.size !== beforeSize) publish();
	});

	pi.on("session_shutdown", async () => {
		clearWarningTimer();
		pi.events.emit(STATUS_BAR_FIRST_LINE_CLEAR_EVENT, { id: EXTENSION_ID });
		readSkillPaths.clear();
		loadedSkillCount = 0;
		statusBarAvailable = false;
		activeSessionContext = undefined;
	});

	pi.registerCommand("skill-stats-debug", {
		description: "Show skill-stats counted skill paths and loaded skill denominator",
		handler: async (_args, ctx) => {
			activeSessionContext = ctx;
			const paths = [...readSkillPaths].sort();
			const message = [
				`skill-stats: ${readSkillPaths.size}/${loadedSkillCount}`,
				paths.length > 0 ? paths.join("\n") : "No SKILL.md files counted yet.",
			].join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(message, "info");
			} else {
				console.log(message);
			}
		},
	});
}
