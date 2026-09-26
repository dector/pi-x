import { describe, expect, test } from "bun:test";
import { parseAgentFields, parseThinkingLevel, parseToolList } from "./agent-parse.ts";

describe("agent frontmatter parsing", () => {
	test("parses a valid function and level", () => {
		expect(
			parseAgentFields({
				name: "reviewer",
				description: "Review",
				short_description: "Reviews code",
				function: "review",
				level: "l",
				tools: "read, bash",
			}),
		).toEqual({
			name: "reviewer",
			description: "Review",
			shortDescription: "Reviews code",
			tools: ["read", "bash"],
			function: "review",
			level: "l",
			model: undefined,
			thinking: undefined,
		});
	});

	test("keeps legacy model/thinking but leaves function undefined", () => {
		const agent = parseAgentFields({
			name: "legacy",
			description: "Legacy",
			model: "openai-codex/gpt-6-sol",
			thinking: "high",
		});
		expect(agent).toMatchObject({ function: undefined, model: "openai-codex/gpt-6-sol", thinking: "high" });
	});

	test("allows a missing function and a valid level", () => {
		const agent = parseAgentFields({ name: "nofunc", description: "No function", level: "l" });
		expect(agent?.function).toBeUndefined();
		expect(agent?.level).toBe("l");
	});

	test("drops an unknown function or level instead of failing", () => {
		const agent = parseAgentFields({ name: "bad", description: "Bad", function: "nope", level: "nope" });
		expect(agent?.function).toBeUndefined();
		expect(agent?.level).toBeUndefined();
	});

	test("returns undefined without a name or description", () => {
		expect(parseAgentFields({ description: "No name" })).toBeUndefined();
		expect(parseAgentFields({ name: "no-desc" })).toBeUndefined();
	});

	test("parses both tool spellings and rejects junk", () => {
		expect(parseToolList("read, bash")).toEqual(["read", "bash"]);
		expect(parseToolList(["read", "bash"])).toEqual(["read", "bash"]);
		expect(parseToolList(42)).toBeUndefined();
		expect(parseToolList("")).toBeUndefined();
	});

	test("accepts only known thinking levels", () => {
		expect(parseThinkingLevel("xhigh")).toBe("xhigh");
		expect(parseThinkingLevel("max")).toBe("max");
		expect(parseThinkingLevel("extreme")).toBeUndefined();
		expect(parseThinkingLevel(3)).toBeUndefined();
	});
});
