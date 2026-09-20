import { expect, test } from "bun:test";
import { SubagentRegistry } from "./registry.ts";
import { emptyUsage } from "./events.ts";

function run(id: string) {
	return {
		runId: id,
		agentName: "worker",
		task: id,
		cwd: "/tmp",
		startedAt: Date.now(),
		result: { agent: "worker", agentSource: "user" as const, task: id, exitCode: 0, messages: [], stderr: "", usage: emptyUsage() },
	};
}

test("registry orders active runs first and bounds completed history", () => {
	const registry = new SubagentRegistry(1);
	registry.start(run("one"));
	registry.complete("one");
	registry.start(run("two"));
	registry.complete("two");
	registry.start(run("active"));
	expect(registry.list().map((item) => item.runId)).toEqual(["active", "two"]);
	registry.complete("active");
	registry.complete("active");
	expect(registry.list()).toHaveLength(1);
});

test("registry notifies on start and on each completion", () => {
	const changes: number[] = [];
	const registry = new SubagentRegistry(30, () => changes.push(registry.list().filter((item) => !item.completedAt).length));
	registry.start(run("one"));
	registry.start(run("two"));
	registry.complete("one");
	registry.complete("one");
	registry.complete("two");
	expect(changes).toEqual([1, 2, 1, 0]);
});
