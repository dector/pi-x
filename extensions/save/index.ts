import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type SessionEntry = {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type ContentBlock = {
	type?: string;
	text?: string;
};

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") {
		return content.trim() ? [content] : [];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const maybeText = block as ContentBlock;
		if (maybeText.type !== "text") continue;
		if (typeof maybeText.text !== "string") continue;
		if (!maybeText.text.trim()) continue;
		parts.push(maybeText.text);
	}

	return parts;
}

function getLatestAssistantResponse(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch() as SessionEntry[];

	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;

		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text) return text;
	}

	return undefined;
}

function formatNowForFilename(now = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
}

function resolveOutputFilename(rawArgs: string): string {
	const args = rawArgs.trim();
	if (args.length > 0) return args;
	return `pi-${formatNowForFilename()}.md`;
}

export default function saveExtension(pi: ExtensionAPI): void {
	pi.registerCommand("save", {
		description: "Save the latest assistant response to a Markdown file",
		handler: async (args, ctx) => {
			const latestResponse = getLatestAssistantResponse(ctx);
			if (!latestResponse) {
				if (ctx.hasUI) {
					ctx.ui.notify("save: no assistant response found to save", "warning");
				}
				return;
			}

			const outputName = resolveOutputFilename(args);
			const outputPath = resolve(ctx.cwd, outputName);

			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, `${latestResponse}\n`, "utf8");

			if (ctx.hasUI) {
				ctx.ui.notify(`save: wrote latest response to ${outputName}`, "info");
			}
		},
	});
}
