import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * hub: central signal hub for pi-x extensions.
 *
 * Bootstrap placeholder. The shared contract (event names, payloads, and
 * capabilities) will be added incrementally. For now the extension loads but
 * emits or handles nothing, so other extensions can depend on it safely while
 * the design settles.
 */
export default function hubExtension(_pi: ExtensionAPI): void {
	// Intentionally empty bootstrap.
}
