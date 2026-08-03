import type { TreeDoc, TreeItem } from "./types";

export type OverviewItem = {
	id: string;
	type: TreeItem["type"];
	priority: TreeItem["priority"];
	title: string | null;
	question?: string;
	status: TreeItem["status"];
	omitted_leaf_decision_count: number;
	children: OverviewItem[];
};

function isLeafDecision(item: TreeItem): boolean {
	return item.type === "decision" && item.children.length === 0;
}

function projectItem(item: TreeItem): OverviewItem | null {
	if (isLeafDecision(item)) return null;
	let omitted = 0;
	const children: OverviewItem[] = [];
	for (const child of item.children) {
		const projected = projectItem(child);
		if (projected) children.push(projected);
		else omitted++;
	}
	return {
		id: item.id,
		type: item.type,
		priority: item.priority,
		title: item.title,
		...(item.type === "decision" ? { question: item.question } : {}),
		status: item.status,
		omitted_leaf_decision_count: omitted,
		children,
	};
}

export function treeOverview(tree: TreeDoc): { id: string; title: string; status: TreeDoc["status"]; root: OverviewItem } {
	return {
		id: tree.id,
		title: tree.title,
		status: tree.status,
		root: projectItem(tree.root)!,
	};
}
