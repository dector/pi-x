import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROC_STOP_ALL_REPLY_EVENT, PROC_STOP_ALL_REQUEST_EVENT } from "../proc/stop-all.ts";
import { stopManagedProcesses } from "./index.ts";

test("-proc waits for the correlated reply and ignores unrelated replies", async () => {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	let requestId = "";
	const events = {
		on(name: string, listener: (payload: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(listener);
			listeners.set(name, set);
			return () => set.delete(listener);
		},
		emit(name: string, payload: unknown) {
			if (name === PROC_STOP_ALL_REQUEST_EVENT) {
				requestId = (payload as { id: string }).id;
				for (const listener of listeners.get(PROC_STOP_ALL_REPLY_EVENT) ?? []) listener({ id: "other", stopped: [], timedOut: [] });
				for (const listener of listeners.get(PROC_STOP_ALL_REPLY_EVENT) ?? []) listener({ id: requestId, stopped: ["vite"], timedOut: [] });
			}
		},
	};
	const result = await stopManagedProcesses({ events } as unknown as ExtensionAPI, "next-session");
	expect(result).toEqual({ id: requestId, stopped: ["vite"], timedOut: [] });
	expect(listeners.get(PROC_STOP_ALL_REPLY_EVENT)?.size).toBe(0);
});
