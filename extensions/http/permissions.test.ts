import { expect, test } from "bun:test";
import {
	classifyHttpFilesystemCall,
	isHttpPermissionTool,
	isMemoryFsReadToolCall,
} from "./permissions.ts";

const PROJECT_ROOT = "/tmp/pi-http-project";

function decide(mode: string, toolName: string, input: Record<string, unknown>, projectRoot = PROJECT_ROOT) {
	return classifyHttpFilesystemCall({ toolName, input, mode, projectRoot });
}

test("isHttpPermissionTool: recognizes only the network tools", () => {
	expect(isHttpPermissionTool("http")).toBe(true);
	expect(isHttpPermissionTool("http_md")).toBe(true);
	expect(isHttpPermissionTool("web_search")).toBe(true);
	expect(isHttpPermissionTool("bash")).toBe(false);
	expect(isHttpPermissionTool("sqlite")).toBe(false);
});

test("isMemoryFsReadToolCall: only memfs-exclusive payloads", () => {
	expect(isMemoryFsReadToolCall("http", { memfs: { id: "mem-1" } })).toBe(true);
	expect(isMemoryFsReadToolCall("http_md", { memfs: { id: "mem-1", offset: 2, limit: 10 } })).toBe(true);
	expect(isMemoryFsReadToolCall("web_search", { memfs: { id: "mem-1" } })).toBe(true);
	// memfs combined with a request field is not a MemoryFS-only read.
	expect(isMemoryFsReadToolCall("http", { memfs: { id: "mem-1" }, url: "https://example.com" })).toBe(false);
	expect(isMemoryFsReadToolCall("http", { url: "https://example.com" })).toBe(false);
	expect(isMemoryFsReadToolCall("bash", { memfs: { id: "mem-1" } })).toBe(false);
});

test("classifyHttpFilesystemCall: MemoryFS reads bypass network entirely", () => {
	for (const mode of ["paranoid", "reader", "smart", "yolo"] as const) {
		expect(decide(mode, "http", { memfs: { id: "mem-1" } })).toEqual({ action: "allow" });
		expect(decide(mode, "http_md", { memfs: { id: "mem-1" } })).toEqual({ action: "allow" });
		expect(decide(mode, "web_search", { memfs: { id: "mem-1" } })).toEqual({ action: "allow" });
	}
});

test("classifyHttpFilesystemCall: no filesystem opinion for plain network calls", () => {
	expect(decide("smart", "http", { url: "https://example.com" })).toBeUndefined();
	expect(decide("smart", "http", { url: "https://example.com", method: "POST" })).toBeUndefined();
	expect(decide("smart", "http_md", { url: "https://example.com" })).toBeUndefined();
	expect(decide("smart", "web_search", { query: "pi coding agent" })).toBeUndefined();
	expect(decide("yolo", "http", { url: "https://example.com", method: "POST" })).toBeUndefined();
});

test("classifyHttpFilesystemCall: http_md to-file output requires approval in every mode", () => {
	for (const mode of ["reader", "smart", "yolo"] as const) {
		expect(decide(mode, "http_md", { url: "https://example.com", spillMode: "to_file" })).toMatchObject({
			action: "confirm",
		});
	}
	expect(decide("yolo", "http_md", { url: "https://example.com", spillMode: "in_memory" })).toBeUndefined();
});

test("classifyHttpFilesystemCall: http output-file safeguards", () => {
	for (const mode of ["reader", "smart"] as const) {
		expect(decide(mode, "http", { url: "https://example.com", outputFile: "download.txt" })).toMatchObject({
			action: "confirm",
		});
		expect(decide(mode, "http", { curlArgs: ["-o", "download.txt", "https://example.com"] })).toMatchObject({
			action: "confirm",
		});
		expect(decide(mode, "http", { curlArgs: ["--output=/tmp/download.txt", "https://example.com"] })).toMatchObject({
			action: "confirm",
		});
	}

	// yolo auto-allows output files inside the project root only.
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "download.txt" })).toEqual({ action: "allow" });
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "/tmp/download.txt" })).toMatchObject({
		action: "confirm",
	});
	expect(decide("yolo", "http", { curlArgs: ["-o", "/tmp/download.txt", "https://example.com"] })).toMatchObject({
		action: "confirm",
	});
	// @-prefixed paths resolve like plain paths.
	expect(decide("yolo", "http", { url: "https://example.com", outputFile: "@download.txt" })).toEqual({ action: "allow" });
});

test("classifyHttpFilesystemCall: ignores non-http tools", () => {
	expect(classifyHttpFilesystemCall({ toolName: "bash", input: {}, mode: "smart", projectRoot: PROJECT_ROOT })).toBeUndefined();
});
