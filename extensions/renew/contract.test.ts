import { expect, test } from "bun:test";
import {
	PROC_STOP_ALL_MAX_WAIT_MS,
	PROC_STOP_ALL_REPLY_EVENT,
	PROC_STOP_ALL_REQUEST_EVENT,
} from "../proc/stop-all.ts";
import { THINKING_LEVELS } from "../subagent/rewire.ts";
import { RENEW_CONTRACT } from "./contract.ts";

// `/renew` mirrors these values locally so a missing sibling cannot break its
// load. This test is the drift guard that keeps the mirrors honest.
test("mirrored constants match their owners", () => {
	expect(RENEW_CONTRACT.thinkingLevels).toEqual([...THINKING_LEVELS]);
	expect(RENEW_CONTRACT.procStopAllRequestEvent).toBe(PROC_STOP_ALL_REQUEST_EVENT);
	expect(RENEW_CONTRACT.procStopAllReplyEvent).toBe(PROC_STOP_ALL_REPLY_EVENT);
	expect(RENEW_CONTRACT.procStopAllMaxWaitMs).toBe(PROC_STOP_ALL_MAX_WAIT_MS);
});
