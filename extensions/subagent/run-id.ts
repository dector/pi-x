/**
 * Short, human-readable subagent and dispatch IDs.
 *
 * Agent runs use the animal world (`ag_shy-lion`). Dispatches use geographic
 * features (`dp_snowy-mountain`). A caller-owned set remembers every name used
 * by a session, so IDs need no random uniqueness suffix and remain unique after
 * an extension reload when that set is retained.
 */

const AGENT_ADJECTIVES = [
	"alert", "bold", "brave", "bright", "calm", "clever", "curious", "eager",
	"fair", "fast", "gentle", "happy", "keen", "kind", "lively", "lucky",
	"mellow", "nimble", "noble", "proud", "quick", "quiet", "royal", "shy",
	"smart", "soft", "swift", "tidy", "tiny", "true", "warm", "wise",
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

const GEOGRAPHIC_ADJECTIVES = [
	"alpine", "blue", "broad", "cedar", "cloudy", "coral", "crystal", "deep",
	"distant", "dry", "emerald", "foggy", "forest", "frosty", "golden", "grand",
	"green", "hidden", "icy", "jade", "lunar", "misty", "northern", "quiet",
	"rocky", "sage", "silver", "snowy", "southern", "sunny", "wild", "windy",
] as const;

const GEOGRAPHIC_FEATURES = [
	"basin", "bay", "beach", "bluff", "canyon", "cape", "cavern", "cliff",
	"coast", "creek", "delta", "desert", "dune", "fjord", "forest", "glacier",
	"glen", "grove", "harbor", "hill", "island", "lake", "marsh", "mesa",
	"mountain", "oasis", "ocean", "pass", "peak", "plain", "plateau", "pond",
	"prairie", "reef", "ridge", "river", "shore", "spring", "strait", "summit",
	"tundra", "vale", "valley", "volcano", "waterfall", "wetland", "wood", "cove",
] as const;

export type HumanIdKind = "agent" | "dispatch";

// Preserve uniqueness for standalone callers that do not provide a session set.
// The subagent runtime passes its own session-retained sets instead.
const fallbackUsedIds: Record<HumanIdKind, Set<string>> = {
	agent: new Set(),
	dispatch: new Set(),
};

function vocabulary(kind: HumanIdKind): {
	prefix: string;
	adjectives: readonly string[];
	nouns: readonly string[];
} {
	return kind === "dispatch"
		? { prefix: "dp", adjectives: GEOGRAPHIC_ADJECTIVES, nouns: GEOGRAPHIC_FEATURES }
		: { prefix: "ag", adjectives: AGENT_ADJECTIVES, nouns: ANIMALS };
}

/**
 * Create an ID generator backed by a reservation set. Omitted sets use a
 * process-wide fallback; the runtime supplies a session-retained set.
 */
export function createRunIdGenerator(
	kind: HumanIdKind = "agent",
	usedIds: Set<string> = fallbackUsedIds[kind],
): () => string {
	const words = vocabulary(kind);
	const capacity = words.adjectives.length * words.nouns.length;
	return () => {
		const start = Math.floor(Math.random() * capacity);
		for (let offset = 0; offset < capacity; offset += 1) {
			const index = (start + offset) % capacity;
			const adjective = words.adjectives[Math.floor(index / words.nouns.length)]!;
			const noun = words.nouns[index % words.nouns.length]!;
			const id = `${words.prefix}_${adjective}-${noun}`;
			if (usedIds.has(id)) continue;
			usedIds.add(id);
			return id;
		}
		throw new Error(`No unused ${kind} names remain in this session.`);
	};
}
