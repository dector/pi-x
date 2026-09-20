// External Herdr integration contract. This event is intentionally not
// namespaced with `px:`: it is owned by Herdr's managed Pi integration, which
// consumes `herdr:blocked` to track when Pi is waiting for user input.
export const HERDR_BLOCKED_EVENT = "herdr:blocked";

/**
 * Emit a balanced Herdr blocked interval around an interactive wait.
 *
 * Emits `{ active: true, label }` immediately before `action` runs and
 * `{ active: false }` in `finally`, preserving the action's result or thrown
 * error. Nested-wait accounting lives in the Herdr consumer.
 */
export async function withHerdrBlocked<T>(
	emit: (event: string, payload: unknown) => void,
	label: string,
	action: () => Promise<T>,
): Promise<T> {
	emit(HERDR_BLOCKED_EVENT, { active: true, label });
	try {
		return await action();
	} finally {
		emit(HERDR_BLOCKED_EVENT, { active: false });
	}
}
