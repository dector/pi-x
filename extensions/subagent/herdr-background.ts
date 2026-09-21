/**
 * Herdr background-work contract.
 *
 * The fork of Herdr's managed Pi integration
 * (`extensions/herdr-agent-state`) consumes `herdr:background` to keep the pane
 * `working` while detached work runs. The official integration ignores it, so
 * emitting is a no-op there.
 *
 * Payload: `{ id, active }`.
 *  - `id` is a stable, non-empty, <= 128 char key. Keyed so concurrent
 *    dispatches cannot clear each other.
 *  - `active: true` registers/refreshes the id; `active: false` clears it.
 *
 * Mirrors the wire string locally; do not import the herdr extension's runtime
 * module from here.
 */

export const HERDR_BACKGROUND_EVENT = "herdr:background";

/** One `herdr:background` lease payload for a subagent dispatch. */
export function herdrBackgroundPayload(dispatchId: string, active: boolean): { id: string; active: boolean } {
	return { id: `subagent:${dispatchId}`, active };
}
