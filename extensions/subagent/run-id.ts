/**
 * Human-readable, process-unique subagent IDs.
 *
 * Run IDs use an adjective-noun pair plus a compact 48-bit uniqueness tag
 * (`red-panda-00k3w9fz2q`). Dispatch IDs keep their namespace
 * (`dispatch-red-panda-00k3w9fz2q`). The readable words make IDs easy to scan;
 * cryptographic randomness keeps collisions across process restarts negligible,
 * while a bounded process-local reservation catches an immediate duplicate.
 */

import { randomBytes } from "node:crypto";

const ADJECTIVES = [
	"amber", "bold", "brave", "bright", "calm", "cedar", "clear", "cool",
	"coral", "cosmic", "crisp", "dawn", "deep", "eager", "fair", "fast",
	"fern", "frost", "gentle", "gold", "grand", "green", "happy", "icy",
	"jade", "keen", "kind", "lively", "lucky", "lunar", "mellow", "mint",
	"misty", "neat", "nimble", "nova", "pearl", "pine", "plum", "proud",
	"quick", "quiet", "rapid", "red", "river", "royal", "sage", "sharp",
	"silver", "smart", "solar", "swift", "tidy", "tiny", "true", "vivid",
	"warm", "wild", "wise", "young", "zesty", "blue", "soft", "stone",
] as const;

const ANIMALS = [
	"badger", "bear", "beaver", "bison", "bobcat", "crane", "crow", "deer",
	"dingo", "dolphin", "eagle", "falcon", "finch", "fox", "gecko", "goat",
	"hare", "heron", "ibis", "jay", "koala", "lemur", "lion", "lynx",
	"marten", "mole", "moose", "newt", "otter", "owl", "panda", "quail",
	"raven", "robin", "seal", "shark", "sloth", "sparrow", "stoat", "swan",
	"tiger", "toad", "trout", "turtle", "viper", "vole", "whale", "wolf",
	"wren", "yak", "zebra", "alpaca", "ant", "bee", "caribou", "cobra",
	"ferret", "gull", "mink", "orca", "puma", "ram", "skink", "tern",
] as const;

const MAX_RESERVED_IDS = 4096;
const issuedIds = new Set<string>();
const issuedOrder: string[] = [];

function randomItem<T>(items: readonly T[]): T {
	return items[Math.floor(Math.random() * items.length)]!;
}

function uniquenessTag(): string {
	return randomBytes(6).readUIntBE(0, 6).toString(36).padStart(10, "0");
}

function reserve(id: string): boolean {
	if (issuedIds.has(id)) return false;
	issuedIds.add(id);
	issuedOrder.push(id);
	if (issuedOrder.length > MAX_RESERVED_IDS) {
		const oldest = issuedOrder.shift();
		if (oldest) issuedIds.delete(oldest);
	}
	return true;
}

export function createRunIdGenerator(prefix = ""): () => string {
	return () => {
		while (true) {
			const readable = `${randomItem(ADJECTIVES)}-${randomItem(ANIMALS)}-${uniquenessTag()}`;
			const id = prefix ? `${prefix}-${readable}` : readable;
			if (reserve(id)) return id;
		}
	};
}
