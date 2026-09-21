/**
 * Tests for the click-to-toggle wrapper used by the dispatch completion
 * message. Mouse events only reach it in fullscreen mode, so the contract that
 * matters is: left click flips the local state exactly once and asks for a
 * render, everything else is left to the parent component.
 */

import { describe, expect, test } from "bun:test";
import type { Component } from "@earendil-works/pi-tui";
import { ClickToggleComponent } from "./completion-view.ts";

/** Records how many times each expansion state was built. */
function countingBuilder(): {
	build: (expanded: boolean) => Component;
	builds: boolean[];
	renders: number[];
} {
	const builds: boolean[] = [];
	const renders: number[] = [];
	const build = (expanded: boolean): Component => {
		builds.push(expanded);
		return {
			render(width: number): string[] {
				renders.push(width);
				return [`expanded=${expanded} width=${width}`];
			},
			invalidate(): void {},
		};
	};
	return { build, builds, renders };
}

describe("ClickToggleComponent", () => {
	test("renders the initial state", () => {
		const { build, builds } = countingBuilder();
		const component = new ClickToggleComponent(build, false);
		expect(component.render(80)).toEqual(["expanded=false width=80"]);
		expect(builds).toEqual([false]);
	});

	test("a left click flips the state and requests a render", () => {
		const { build, builds } = countingBuilder();
		const component = new ClickToggleComponent(build, false);
		expect(component.handleMouse({ type: "click", button: "left" })).toEqual({ handled: true, render: true });
		expect(component.render(80)).toEqual(["expanded=true width=80"]);
		// Nothing is built before the first render, and the toggle builds once.
		expect(builds).toEqual([true]);
	});

	test("clicking twice returns to the collapsed state", () => {
		const { build, builds } = countingBuilder();
		const component = new ClickToggleComponent(build, false);
		component.handleMouse({ type: "click", button: "left" });
		component.handleMouse({ type: "click", button: "left" });
		expect(component.render(80)).toEqual(["expanded=false width=80"]);
		// Both clicks happen before the render, so only the final state is built.
		expect(builds).toEqual([false]);
	});

	test("ignores non-click events, other buttons, and wheel input", () => {
		const { build, builds } = countingBuilder();
		const component = new ClickToggleComponent(build, false);
		expect(component.handleMouse({ type: "press", button: "left" })).toBeUndefined();
		expect(component.handleMouse({ type: "click", button: "right" })).toBeUndefined();
		expect(component.handleMouse({ type: "wheel", button: "none" })).toBeUndefined();
		component.render(80);
		expect(builds).toEqual([false]);
	});

	test("reuses the built child across renders until the state changes", () => {
		const { build, builds } = countingBuilder();
		const component = new ClickToggleComponent(build, false);
		component.render(80);
		component.render(80);
		component.render(120);
		expect(builds).toEqual([false]);
	});

	test("invalidate drops the cached child so the next render rebuilds", () => {
		const { build, builds } = countingBuilder();
		const component = new ClickToggleComponent(build, true);
		component.render(80);
		component.invalidate();
		component.render(80);
		expect(builds).toEqual([true, true]);
	});

	test("starts expanded when the harness already has tool output expanded", () => {
		const { build, builds } = countingBuilder();
		const component = new ClickToggleComponent(build, true);
		expect(component.render(80)).toEqual(["expanded=true width=80"]);
		expect(builds).toEqual([true]);
	});
});
