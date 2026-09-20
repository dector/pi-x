// External Herdr integration contract. This event is intentionally not
// namespaced with `px:`: it is owned by Herdr's managed Pi integration, which
// consumes `herdr:blocked` to track when Pi is waiting for user input.
//
// Safe-mode emits this directly only as a fallback when no hub acknowledges its
// user-wait declaration. When hub is present, hub owns the aggregate transition
// and emits the single enter/exit pair.
export const HERDR_BLOCKED_EVENT = "herdr:blocked";
