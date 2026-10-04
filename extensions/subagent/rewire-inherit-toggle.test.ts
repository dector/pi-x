import { describe, expect, test } from "bun:test";
import { SessionInheritedRewireToggle } from "./rewire-inherit-toggle.ts";
import type { SubagentRewireConfig } from "./types.ts";

const target: SubagentRewireConfig = { enabled: false, model: "provider/target", thinkingLevel: "high" };

describe("session inherited rewire toggle", () => {
	for (const enabled of [false, true]) {
		test(`restores the previous target, effort and enabled=${enabled}`, () => {
			const toggle = new SessionInheritedRewireToggle();
			const previous = { ...target, enabled };
			const inherited = toggle.toggle("session", previous, "provider/main");
			expect(inherited).toMatchObject({ enabled: true, inheritAll: true, inherit: false, model: "provider/main" });
			expect(toggle.toggle("session", inherited, "provider/new-main")).toEqual(previous);
			expect(previous).toEqual({ ...target, enabled });
		});
	}

	test("isolates return targets by session and does not persist across instances", () => {
		const toggle = new SessionInheritedRewireToggle();
		const first = toggle.toggle("first", target, "provider/main");
		const other = { ...target, model: "provider/other", thinkingLevel: "low" as const };
		const second = toggle.toggle("second", other, "provider/main");
		expect(toggle.toggle("first", first)).toEqual(target);
		expect(toggle.toggle("second", second)).toEqual(other);
		const fresh = new SessionInheritedRewireToggle();
		expect(fresh.toggle("first", first)).toEqual({ ...first, enabled: false });
	});

	test("a newly chosen fixed target becomes the next return target", () => {
		const toggle = new SessionInheritedRewireToggle();
		toggle.toggle("session", target, "provider/main");
		const next = { ...target, model: "provider/next", enabled: true };
		const inherited = toggle.toggle("session", next, "provider/main");
		expect(toggle.toggle("session", inherited)).toEqual(next);
	});
});
