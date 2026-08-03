import { shortId } from "./format";

export type CommandTreeSummary = {
	id: string;
	title: string;
	status: string;
	updated_at: string;
	active?: boolean;
};

export function helpText(): string {
	return [
		"Decision tree commands:",
		"  /dt init              Initialize docs/.decisions/",
		"  /dt status            Show project decision tree status",
		"  /dt list              List decision trees",
		"  /dt select <id>       Select a tree by full ID or unique prefix",
	].join("\n");
}

export function formatInit(input: {
	projectRoot: string;
	decisionsPath: string;
	indexPath: string;
	sessionPath: string;
	gitignoreExisted: boolean;
	created: boolean;
}): string {
	return [
		input.created ? "Decision tree storage initialized." : "Decision tree storage already initialized.",
		`project root: ${input.projectRoot}`,
		`decisions path: ${input.decisionsPath}`,
		`index path: ${input.indexPath}`,
		`session path: ${input.sessionPath}`,
		`.gitignore: ${input.gitignoreExisted ? "existed" : "created"}`,
	].join("\n");
}

export function formatStatus(input: {
	initialized: boolean;
	projectRoot: string;
	decisionsPath: string;
	activeTree?: CommandTreeSummary | null;
	activeItemId?: string | null;
	activeItemPath?: string | null;
	treeCount?: number;
	unresolvedCount?: number;
}): string {
	const lines = [
		`initialized: ${input.initialized ? "yes" : "no"}`,
		`project root: ${input.projectRoot}`,
		`decisions path: ${input.decisionsPath}`,
	];
	if (!input.initialized) {
		lines.push("suggestion: run /dt init");
		return lines.join("\n");
	}
	lines.push(`tree count: ${input.treeCount ?? 0}`);
	lines.push(`active tree: ${input.activeTree ? `${input.activeTree.title} (${shortId(input.activeTree.id)})` : "none"}`);
	lines.push(`active item: ${input.activeItemId ? `${shortId(input.activeItemId)}${input.activeItemPath ? ` - ${input.activeItemPath}` : ""}` : "none"}`);
	if (input.unresolvedCount !== undefined) lines.push(`unresolved: ${input.unresolvedCount}`);
	return lines.join("\n");
}

export function formatList(trees: CommandTreeSummary[]): string {
	if (trees.length === 0) return "No decision trees found. Create one through the agent/tool workflow.";
	return [
		"Decision trees:",
		...trees.map((tree) => {
			const marker = tree.active ? "*" : " ";
			return `${marker} ${shortId(tree.id)}  ${tree.status.padEnd(10)}  ${tree.updated_at}  ${tree.title}`;
		}),
	].join("\n");
}

export function formatSelected(input: { id: string; title: string; activeItemId: string; path: string }): string {
	return [
		`Selected: ${input.title} (${shortId(input.id)})`,
		`active item: ${shortId(input.activeItemId)} - ${input.path}`,
	].join("\n");
}
