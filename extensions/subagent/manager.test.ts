/**
 * Stage 5 manager UX tests.
 *
 * These exercise the pure action/Details decisions and the `ManagerHerdrActions`
 * service through a fake pane port, so Jump/Close/stale behavior is verified
 * without a Pi runtime or a live Herdr server.
 */

import { describe, expect, test } from "bun:test";
import { HerdrTabError } from "./herdr-tab.ts";
import {
	ManagerHerdrActions,
	applyDispatchOwnership,
	buildManagerPicker,
	clearHerdrLocation,
	derivedPaneStatus,
	describeManagerRun,
	descriptorFromEntry,
	descriptorFromRun,
	hasHerdrPane,
	isRetainedCompleted,
	isStalePaneError,
	managerActions,
	managerDetails,
	mergeManagerDescriptors,
	shouldAbortDispatch,
	type DispatchOwnershipSource,
	type HerdrManagerPort,
	type ManagerRunDescriptor,
	type PersistedEntryLike,
	type RegistryRunLike,
} from "./manager.ts";
import type { HerdrPaneStatus } from "./herdr-tab.ts";
import type { HerdrRunLocation } from "./types.ts";

const location = (overrides: Partial<HerdrRunLocation> = {}): HerdrRunLocation => ({
	tabId: "w1:t1",
	paneId: "w1:p2",
	retained: false,
	...overrides,
});

function activeProcess(overrides: Partial<ManagerRunDescriptor> = {}): ManagerRunDescriptor {
	return {
		runId: "sa-1",
		agentName: "worker",
		task: "do the thing",
		active: true,
		failed: false,
		state: "running",
		mode: "smart",
		...overrides,
	};
}

function completedProcess(overrides: Partial<ManagerRunDescriptor> = {}): ManagerRunDescriptor {
	return {
		runId: "sa-2",
		agentName: "worker",
		task: "do the thing",
		active: false,
		failed: false,
		mode: "smart",
		...overrides,
	};
}

describe("manager actions", () => {
	test("process-backed actions are unchanged", () => {
		expect(managerActions(activeProcess())).toEqual([
			"Attach",
			"Details",
			"Configure permissions",
			"Pause",
			"Abort",
			"Back",
		]);
		expect(managerActions(activeProcess({ state: "paused" }))).toContain("Resume");
		expect(managerActions(completedProcess())).toEqual(["View transcript", "Details", "Back"]);
	});

	test("active attached blocking runs offer Continue in background", () => {
		expect(managerActions(activeProcess({ attachedBlocking: true }))).toEqual([
			"Attach",
			"Continue in background",
			"Details",
			"Configure permissions",
			"Pause",
			"Abort",
			"Back",
		]);
	});

	test("Continue in background is hidden for detached or completed runs", () => {
		expect(managerActions(activeProcess())).not.toContain("Continue in background");
		expect(managerActions(activeProcess({ detached: true }))).not.toContain("Continue in background");
		expect(managerActions(completedProcess({ attachedBlocking: true }))).not.toContain("Continue in background");
	});

	test("active Herdr runs gain Jump after Details", () => {
		const actions = managerActions(activeProcess({ backend: "herdr", herdr: location() }));
		expect(actions).toEqual([
			"Attach",
			"Details",
			"Jump to Herdr pane",
			"Configure permissions",
			"Pause",
			"Abort",
			"Back",
		]);
	});

	test("retained completed Herdr runs gain Jump and Close", () => {
		const actions = managerActions(
			completedProcess({ backend: "herdr", herdr: location({ retained: true }), herdrRetention: "always" }),
		);
		expect(actions).toEqual([
			"View transcript",
			"Details",
			"Jump to Herdr pane",
			"Close retained pane",
			"Back",
		]);
	});

	test("completed Herdr runs without retention do not offer Close", () => {
		const actions = managerActions(completedProcess({ backend: "herdr", herdr: location({ retained: false }) }));
		expect(actions).toContain("Jump to Herdr pane");
		expect(actions).not.toContain("Close retained pane");
	});

	test("a missing pane hides Jump and Close", () => {
		const actions = managerActions(
			completedProcess({
				backend: "herdr",
				herdr: location({ retained: true }),
				paneStatus: "missing",
			}),
		);
		expect(actions).not.toContain("Jump to Herdr pane");
		expect(actions).not.toContain("Close retained pane");
	});

	test("helpers classify locations", () => {
		expect(hasHerdrPane(completedProcess())).toBe(false);
		expect(hasHerdrPane(completedProcess({ herdr: location() }))).toBe(true);
		expect(derivedPaneStatus(completedProcess({ herdr: location({ retained: true }) }))).toBe("retained");
		expect(derivedPaneStatus(activeProcess({ herdr: location() }))).toBe("active");
		expect(isRetainedCompleted(completedProcess({ herdr: location({ retained: true }) }))).toBe(true);
		expect(isRetainedCompleted(activeProcess({ herdr: location({ retained: true }) }))).toBe(false);
	});
});

describe("manager details", () => {
	test("includes Backend, tab, pane, retention, and status", () => {
		const text = managerDetails(
			activeProcess({ backend: "herdr", herdr: location(), herdrRetention: "failed", dispatchId: "dispatch-1" }),
		);
		expect(text).toContain("Backend: herdr");
		expect(text).toContain("Herdr tab: w1:t1");
		expect(text).toContain("Herdr pane: w1:p2");
		expect(text).toContain("Retention: failed");
		expect(text).toContain("Pane status: active");
		expect(text).toContain("Dispatch: dispatch-1");
	});

	test("reports retained and missing status", () => {
		expect(managerDetails(completedProcess({ backend: "herdr", herdr: location({ retained: true }) }))).toContain(
			"Pane status: retained",
		);
		expect(
			managerDetails(completedProcess({ backend: "herdr", herdr: location({ retained: true }), paneStatus: "missing" })),
		).toContain("Pane status: missing");
	});

	test("omits Herdr fields for process runs", () => {
		const text = managerDetails(completedProcess());
		expect(text).not.toContain("Backend:");
		expect(text).not.toContain("Herdr tab:");
		expect(text).not.toContain("Pane status:");
	});

	test("marks a detached blocking dispatch as background ownership", () => {
		expect(managerDetails(activeProcess({ detached: true }))).toContain(
			"Ownership: background (detached from blocking turn)",
		);
		expect(managerDetails(activeProcess())).not.toContain("Ownership:");
	});
});

describe("descriptor mapping", () => {
	function registryRun(overrides: Partial<RegistryRunLike> = {}): RegistryRunLike {
		return {
			runId: "sa-1",
			agentName: "worker",
			task: "do it",
			cwd: "/work",
			startedAt: 1000,
			result: { state: "running", effectiveMode: "smart", exitCode: 0 },
			...overrides,
		};
	}

	function persistedEntry(overrides: Partial<PersistedEntryLike> = {}): PersistedEntryLike {
		return {
			runId: "sa-9",
			agentName: "worker",
			task: "old task",
			status: "completed",
			backend: "herdr",
			herdr: location({ retained: true }),
			...overrides,
		};
	}

	test("maps live registry fields and failure state", () => {
		const descriptor = descriptorFromRun(
			registryRun({
				completedAt: 2000,
				child: { pid: 42 },
				backend: "herdr",
				herdr: location(),
				herdrRetention: "failed",
				dispatchId: "dispatch-1",
				result: { state: "failed", effectiveMode: "smart", exitCode: 1, errorMessage: "boom" },
			}),
		);
		expect(descriptor.active).toBe(false);
		expect(descriptor.failed).toBe(true);
		expect(descriptor.pid).toBe(42);
		expect(descriptor.backend).toBe("herdr");
		expect(descriptor.dispatchId).toBe("dispatch-1");
		expect(descriptor.persisted).toBeUndefined();
	});

	test("maps detached ownership onto the descriptor", () => {
		expect(descriptorFromRun(registryRun({ detached: true })).detached).toBe(true);
		expect(descriptorFromRun(registryRun()).detached).toBeUndefined();
	});

	test("maps persisted entries as non-live", () => {
		const descriptor = descriptorFromEntry(persistedEntry());
		expect(descriptor.persisted).toBe(true);
		expect(descriptor.active).toBe(false);
		expect(descriptor.herdr?.retained).toBe(true);
	});

	test("merge keeps process history out and appends pruned Herdr runs", () => {
		const merged = mergeManagerDescriptors(
			[registryRun({ runId: "sa-1" })],
			[
				persistedEntry({ runId: "sa-process", backend: "process", herdr: undefined }),
				persistedEntry({ runId: "sa-herdr" }),
			],
		);
		expect(merged.map((descriptor) => descriptor.runId)).toEqual(["sa-1", "sa-herdr"]);
	});

	test("merge never duplicates a registry run and honors dismissals", () => {
		const merged = mergeManagerDescriptors(
			[registryRun({ runId: "sa-1" })],
			[persistedEntry({ runId: "sa-1" }), persistedEntry({ runId: "sa-2" })],
			new Set(["sa-2"]),
		);
		expect(merged.map((descriptor) => descriptor.runId)).toEqual(["sa-1"]);
	});
});

describe("dispatch ownership overlay", () => {
	function source(attached: string[] = [], detached: string[] = []): DispatchOwnershipSource {
		return {
			isAttached: (dispatchId) => attached.includes(dispatchId),
			wasEverDetached: (dispatchId) => detached.includes(dispatchId),
		};
	}

	test("stamps attached blocking ownership from the lifecycle handle", () => {
		const [descriptor] = applyDispatchOwnership([activeProcess({ dispatchId: "d1" })], source(["d1"]));
		expect(descriptor?.attachedBlocking).toBe(true);
		expect(descriptor?.detached).toBeUndefined();
		expect(managerActions(descriptor as ManagerRunDescriptor)).toContain("Continue in background");
	});

	test("marks a run that registered after detach as background ownership", () => {
		const descriptor = activeProcess({ dispatchId: "d1", runId: "sa-late-chain-step" });
		const [overlaid] = applyDispatchOwnership([descriptor], source([], ["d1"]));
		expect(overlaid?.detached).toBe(true);
		expect(overlaid?.attachedBlocking).toBeUndefined();
		expect(managerDetails(overlaid as ManagerRunDescriptor)).toContain(
			"Ownership: background (detached from blocking turn)",
		);
		expect(managerActions(overlaid as ManagerRunDescriptor)).not.toContain("Continue in background");
	});

	test("preserves an already-stamped detached descriptor", () => {
		const [descriptor] = applyDispatchOwnership(
			[activeProcess({ dispatchId: "d1", detached: true })],
			source([], []),
		);
		expect(descriptor?.detached).toBe(true);
	});

	test("returns untouched descriptors with no dispatch or no ownership", () => {
		const noDispatch = activeProcess();
		const unowned = activeProcess({ dispatchId: "d2" });
		const result = applyDispatchOwnership([noDispatch, unowned], source([], []));
		expect(result[0]).toBe(noDispatch);
		expect(result[1]).toBe(unowned);
	});
});

describe("manager abort scope", () => {
	test("aborts the dispatch only when it is not attached to a blocking turn", () => {
		// Detached/async: cancel the whole dispatch so queued work stops.
		expect(shouldAbortDispatch("d1", () => false)).toBe(true);
		// Attached blocking: per-run abort so parallel siblings keep running.
		expect(shouldAbortDispatch("d1", () => true)).toBe(false);
		// No dispatch id: only the run handle applies.
		expect(shouldAbortDispatch(undefined, () => false)).toBe(false);
	});
});

describe("manager picker", () => {
	test("labels are stable and made unique", () => {
		const descriptors = [
			completedProcess({ runId: "sa-1" }),
			completedProcess({ runId: "sa-1" }),
			activeProcess({ runId: "sa-3" }),
		];
		const { labels, byLabel } = buildManagerPicker(descriptors, 1000);
		expect(labels).toHaveLength(3);
		expect(new Set(labels).size).toBe(3);
		expect(byLabel.get(labels[2])).toBe(2);
		expect(labels[0]).toBe(describeManagerRun(descriptors[0], 1000));
	});
});

describe("clearHerdrLocation", () => {
	test("clears only the location and preserves the recorded result", () => {
		const result = { herdr: location(), messages: [{ role: "assistant" }], exitCode: 0 };
		const run = { herdr: location(), result };
		clearHerdrLocation(run);
		expect(run.herdr).toBeUndefined();
		expect(result.herdr).toBeUndefined();
		expect(result.messages).toHaveLength(1);
		expect(result.exitCode).toBe(0);
	});
});

interface FakePortCalls {
	focused: HerdrRunLocation[];
	closed: HerdrRunLocation[];
	statusCalls: HerdrRunLocation[];
}

function fakePort(options: {
	focusError?: unknown;
	closeError?: unknown;
	closeResult?: boolean;
	status?: HerdrPaneStatus;
} = {}): { port: HerdrManagerPort; calls: FakePortCalls } {
	const calls: FakePortCalls = { focused: [], closed: [], statusCalls: [] };
	return {
		calls,
		port: {
			async focusLocation(loc) {
				calls.focused.push(loc);
				if (options.focusError !== undefined) throw options.focusError;
			},
			async closeRetainedLocation(loc) {
				calls.closed.push(loc);
				if (options.closeError !== undefined) throw options.closeError;
				return options.closeResult ?? true;
			},
			async paneStatus(loc) {
				calls.statusCalls.push(loc);
				return options.status ?? "active";
			},
		},
	};
}

describe("ManagerHerdrActions", () => {
	test("jump focuses the exact recorded pane", async () => {
		const loc = location();
		const { port, calls } = fakePort();
		const actions = new ManagerHerdrActions(port);
		const result = await actions.jump(loc);
		expect(result.ok).toBe(true);
		expect(result.stale).toBe(false);
		expect(calls.focused).toEqual([loc]);
	});

	test("jump reports missing panes as stale", async () => {
		const loc = location({ retained: true });
		const { port } = fakePort({ focusError: new HerdrTabError("gone", { code: "missing_pane" }) });
		const actions = new ManagerHerdrActions(port);
		const result = await actions.jump(loc);
		expect(result.ok).toBe(false);
		expect(result.stale).toBe(true);
		expect(result.status).toBe("missing");
		expect(result.message).toContain(loc.paneId);
	});

	test("jump surfaces non-stale errors without clearing", async () => {
		const { port } = fakePort({ focusError: new Error("server unreachable") });
		const actions = new ManagerHerdrActions(port);
		const result = await actions.jump(location());
		expect(result.ok).toBe(false);
		expect(result.stale).toBe(false);
		expect(result.message).toContain("server unreachable");
	});

	test("close refuses non-retained and unowned panes", async () => {
		const { port, calls } = fakePort();
		const actions = new ManagerHerdrActions(port);
		const refused = await actions.closeRetained(location({ retained: false }));
		expect(refused.ok).toBe(false);
		expect(calls.closed).toHaveLength(0);

		const unowned = await new ManagerHerdrActions(fakePort({ closeResult: false }).port).closeRetained(
			location({ retained: true }),
		);
		expect(unowned.ok).toBe(false);
		expect(unowned.message).toContain("not owned");
	});

	test("close reports success and treats the location as gone", async () => {
		const loc = location({ retained: true });
		const { port, calls } = fakePort();
		const result = await new ManagerHerdrActions(port).closeRetained(loc);
		expect(result.ok).toBe(true);
		expect(result.stale).toBe(true);
		expect(result.status).toBe("missing");
		expect(calls.closed).toEqual([loc]);
	});

	test("close treats an already-closed pane as stale", async () => {
		const { port } = fakePort({ closeError: new HerdrTabError("gone", { code: "missing_pane" }) });
		const result = await new ManagerHerdrActions(port).closeRetained(location({ retained: true }));
		expect(result.ok).toBe(false);
		expect(result.stale).toBe(true);
		expect(result.status).toBe("missing");
	});

	test("status maps probe results and failures", async () => {
		const { port, calls } = fakePort({ status: "retained" });
		const actions = new ManagerHerdrActions(port);
		expect(await actions.status(location({ retained: true }))).toBe("retained");
		expect(calls.statusCalls).toHaveLength(1);

		const throwing: HerdrManagerPort = {
			focusLocation: async () => {},
			closeRetainedLocation: async () => false,
			paneStatus: async () => {
				throw new Error("unreachable");
			},
		};
		expect(await new ManagerHerdrActions(throwing).status(location())).toBe("missing");
	});

	test("classifies stale errors only", () => {
		expect(isStalePaneError(new HerdrTabError("x", { code: "missing_pane" }))).toBe(true);
		expect(isStalePaneError(new HerdrTabError("x", { code: "not_owned" }))).toBe(true);
		expect(isStalePaneError(new HerdrTabError("x", { code: "disposed" }))).toBe(false);
		expect(isStalePaneError(new Error("x"))).toBe(false);
	});
});
