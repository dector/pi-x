/// <reference path="../persistence/node-shims.d.ts" />

import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDecisionTreePiContext } from "./context";
import { errorResult, shortId } from "./format";
import { formatInit, formatList, formatSelected, formatStatus, helpText, type CommandTreeSummary } from "./command-format";
import { resolveStoragePaths } from "../persistence";

export function registerDecisionTreeCommands(pi: ExtensionAPI): void {
	pi.registerCommand("dt", {
		description: "Decision tree setup, status, list, and selection",
		getArgumentCompletions: (prefix) => {
			const commands = ["init", "status", "list", "select"];
			return commands.filter((command) => command.startsWith(prefix.trim())).map((command) => ({ value: command, label: command }));
		},
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (!subcommand || subcommand === "status") {
					ctx.ui.notify(await statusText(ctx.cwd), "info");
					return;
				}
				if (subcommand === "init") {
					ctx.ui.notify(await initText(ctx.cwd), "info");
					return;
				}
				if (subcommand === "list") {
					ctx.ui.notify(await listText(ctx.cwd), "info");
					return;
				}
				if (subcommand === "select") {
					const selected = await selectText(ctx.cwd, rest.join(" "), ctx.hasUI ? ctx.ui.select.bind(ctx.ui) : null);
					ctx.ui.notify(selected, "info");
					return;
				}
				ctx.ui.notify(helpText(), "info");
			} catch (error) {
				ctx.ui.notify(errorResult(error).content[0]?.text ?? String(error), "error");
			}
		},
	});
}

async function initText(cwd: string): Promise<string> {
	const dt = await createDecisionTreePiContext(cwd);
	const paths = resolveStoragePaths(dt.projectRoot);
	const gitignoreExisted = await exists(`${paths.decisionsDir}/.gitignore`);
	const result = await dt.service.init(dt.projectRoot);
	return formatInit({
		projectRoot: dt.projectRoot,
		decisionsPath: dt.decisionsPath,
		indexPath: paths.indexFile,
		sessionPath: paths.sessionFile,
		gitignoreExisted,
		created: result.created,
	});
}

async function statusText(cwd: string): Promise<string> {
	const dt = await createDecisionTreePiContext(cwd);
	const session = await dt.service.getSession(dt.projectRoot);
	if (!session.initialized) return formatStatus({ initialized: false, projectRoot: dt.projectRoot, decisionsPath: dt.decisionsPath });

	const trees = await dt.service.listTrees(dt.projectRoot);
	const activeTree = trees.find((tree) => tree.active) ?? null;
	let activeItemPath: string | null = null;
	if (session.session?.active_tree_id && session.session.active_item_id) {
		try {
			activeItemPath = (await dt.service.getItem(dt.projectRoot, { tree_id: session.session.active_tree_id, item_id: session.session.active_item_id })).path ?? null;
		} catch {}
	}
	let unresolvedCount: number | undefined;
	try {
		unresolvedCount = (await dt.service.nextUnresolved(dt.projectRoot)).items.length;
	} catch {}
	return formatStatus({
		initialized: true,
		projectRoot: dt.projectRoot,
		decisionsPath: dt.decisionsPath,
		activeTree,
		activeItemId: session.session?.active_item_id ?? null,
		activeItemPath,
		treeCount: trees.length,
		unresolvedCount,
	});
}

async function listText(cwd: string): Promise<string> {
	const dt = await createDecisionTreePiContext(cwd);
	const trees = await dt.service.listTrees(dt.projectRoot);
	return formatList(trees);
}

async function selectText(cwd: string, idPrefix: string, select: null | ((title: string, items: string[]) => Promise<string | null | undefined>)): Promise<string> {
	const dt = await createDecisionTreePiContext(cwd);
	let prefix = idPrefix.trim();
	if (!prefix) {
		if (!select) return "Usage: /dt select <id-prefix>";
		const trees = await dt.service.listTrees(dt.projectRoot);
		if (trees.length === 0) return "No decision trees found. Create one through the agent/tool workflow.";
		const choice = await select("Select decision tree", trees.map(selectLabel));
		if (!choice) return "Selection cancelled.";
		prefix = choice.trim().split(/\s+/, 1)[0] ?? "";
	}
	const result = await dt.service.selectTree(dt.projectRoot, prefix);
	return formatSelected({ id: result.tree.id, title: result.tree.title, activeItemId: result.active_item_id, path: result.path });
}

function selectLabel(tree: CommandTreeSummary): string {
	const marker = tree.active ? "*" : " ";
	return `${shortId(tree.id)} ${marker} ${tree.title}`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}
