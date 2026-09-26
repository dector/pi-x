import { expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { gustClient } from "./gust.ts";

const submitted =
	'{"id":"t1","path":"/p","text":"x","html":"","locator":"","state":"submitted","messages":[],"createdAt":"c","updatedAt":"u"}';
const seen =
	'{"id":"t1","path":"/p","text":"x","html":"","locator":"","state":"seen","messages":[],"createdAt":"c","updatedAt":"u"}';

test("watch and seen parse ctl output", async () => {
	const script = `/tmp/gust-fake-${process.pid}.sh`;
	const log = `${script}.log`;
	writeFileSync(
		script,
		`#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(log)}
case "$*" in
  *"comments watch"*) echo '{"cursor":7,"comments":[${submitted}]}' ;;
  *"comments seen"*) echo '${seen}' ;;
  *) echo '[]' ;;
esac
`,
	);
	chmodSync(script, 0o755);
	process.env.GUST_CMD = script;
	try {
		const snapshot = await gustClient.watch(0);
		expect(snapshot.cursor).toBe(7);
		expect(snapshot.comments[0]?.state).toBe("submitted");

		const claimed = await gustClient.seen("t1");
		expect(claimed.state).toBe("seen");

		const calls = await Bun.file(log).text();
		expect(calls).toContain("comments watch --since 0");
		expect(calls).toContain("comments seen t1");
	} finally {
		delete process.env.GUST_CMD;
		rmSync(script, { force: true });
		rmSync(log, { force: true });
	}
});
