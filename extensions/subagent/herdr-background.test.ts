import { describe, expect, test } from "bun:test";
import { HERDR_BACKGROUND_EVENT, herdrBackgroundPayload } from "./herdr-background.ts";

describe("herdr background contract", () => {
	test("uses the event name the Herdr integration fork consumes", () => {
		expect(HERDR_BACKGROUND_EVENT).toBe("herdr:background");
	});

	test("keys the lease by dispatch id", () => {
		expect(herdrBackgroundPayload("dispatch-1", true)).toEqual({ id: "subagent:dispatch-1", active: true });
		expect(herdrBackgroundPayload("dispatch-1", false)).toEqual({ id: "subagent:dispatch-1", active: false });
	});

	test("concurrent dispatches get distinct ids", () => {
		expect(herdrBackgroundPayload("a", true).id).not.toBe(herdrBackgroundPayload("b", true).id);
	});

	test("id fits the integration bound", () => {
		expect(herdrBackgroundPayload("dispatch-1", true).id.length).toBeLessThanOrEqual(128);
	});
});
