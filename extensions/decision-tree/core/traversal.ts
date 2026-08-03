import type { TreeDoc, TreeItem } from "./types";

export type ItemLocation = {
	item: TreeItem;
	parent: TreeItem | null;
	path: TreeItem[];
	index: number;
};

export function walkItems(root: TreeItem, visitor: (item: TreeItem, path: TreeItem[], parent: TreeItem | null, index: number) => void): void {
	function visit(item: TreeItem, path: TreeItem[], parent: TreeItem | null, index: number): void {
		visitor(item, path, parent, index);
		item.children.forEach((child, childIndex) => visit(child, [...path, child], item, childIndex));
	}
	visit(root, [root], null, 0);
}

export function findItem(tree: TreeDoc, itemId: string): ItemLocation | null {
	let found: ItemLocation | null = null;
	walkItems(tree.root, (item, path, parent, index) => {
		if (!found && item.id === itemId) found = { item, parent, path, index };
	});
	return found;
}

export function itemLabel(item: TreeItem, treeTitle?: string): string {
	if (item.type === "group") return item.title || treeTitle || "<root>";
	return item.title || item.question;
}

export function itemPath(tree: TreeDoc, path: readonly TreeItem[]): string {
	return path.map((item) => itemLabel(item, tree.title)).join(" / ");
}

export function isDescendantOrSelf(root: TreeItem, itemId: string): boolean {
	let found = false;
	walkItems(root, (item) => {
		if (item.id === itemId) found = true;
	});
	return found;
}
