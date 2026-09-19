import { expect, test } from "bun:test";
import { classifyHttpToolCall } from "./permissions.ts";

const PROJECT_ROOT = "/tmp/pi-http-project";

function decide(mode: string, toolName: string, input: Record<string, unknown>, projectRoot = PROJECT_ROOT) {
	return classifyHttpToolCall({ toolName, input, mode, projectRoot })?.action;
}

test("classifyHttpToolCall: read-only calls auto-allow", () => {
	for (const mode of ["reader", "smart", "yolo"] as const) {
		expect(decide(mode, "http", { url: "https://example.com" })).toBe("allow");
		expect(decide(mode, "http", { url: "https://example.com", method: "GET" })).toBe("allow");
		expect(decide(mode, "http", { url: "https://example.com", method: "head" })).toBe("allow");
		expect(decide(mode, "http", { url: "https://example.com", method: "OPTIONS" })).toBe("allow");
		expect(decide(mode, "http_md", { url: "https://example.com", method: "GET" })).toBe("allow");
		expect(decide(mode, "web_search", { query: "pi coding agent" })).toBe("allow");
		expect(decide(mode, "web_search", { query: "pi coding agent", pages: 2, resultsPerPage: 10 })).toBe("allow");
		expect(decide(mode, "http", { memfs: { id: "mem-1" } })).toBe("allow");
		expect(decide(mode, "http_md", { memfs: { id: "mem-1", offset: 2, limit: 10 } })).toBe("allow");
		expect(decide(mode, "web_search", { memfs: { id: "mem-1" } })).toBe("allow");
	}
});

test("classifyHttpToolCall: mutations require approval outside yolo", () => {
	for (const mode of ["reader", "smart"] as const) {
		expect(decide(mode, "http", { url: "https://example.com", method: "POST" })).toBe("confirm");
		expect(decide(mode, "http_md", { url: "https://example.com", method: "DELETE" })).toBe("confirm");
		expect(decide(mode, "http_md", { url: "https://example.com", spillMode: "to_file" })).toBe("confirm");
		expect(decide(mode, "http", { url: "https://example.com", outputFile: "download.txt" })).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["-X", "POST", "https://example.com"] })).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["-d", "name=value", "https://example.com"] })).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["-o", "download.txt", "https://example.com"] })).toBe("confirm");
		expect(decide(mode, "http", { curlArgs: ["--output=/tmp/download.txt", "https://example.com"] })).toBe("confirm");
	}
});

test("classifyHttpToolCall: yolo exceptions", () => {
	expect(decide("yolo", "http", { url: "https://example.com", method: "POST" })).toBe("allow");
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "download.txt" })).toBe("allow");
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "/tmp/download.txt" })).toBe("confirm");
	expect(decide("yolo", "http", { curlArgs: ["-o", "/tmp/download.txt", "https://example.com"] })).toBe("confirm");
	expect(decide("yolo", "http_md", { url: "https://example.com", spillMode: "to_file" })).toBe("confirm");
});

test("classifyHttpToolCall: ignores non-http tools", () => {
	expect(classifyHttpToolCall({ toolName: "bash", input: {}, mode: "smart", projectRoot: PROJECT_ROOT })).toBeUndefined();
});
