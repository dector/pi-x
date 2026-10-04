import { isInheritAllRewire } from "./rewire.ts";
import type { SubagentRewireConfig } from "./types.ts";

/** Temporary overrides and their return targets live only in this process. */
export class SessionInheritedRewireToggle {
	private previous = new Map<string, SubagentRewireConfig>();

	toggle(sessionId: string, config: SubagentRewireConfig, currentModel?: string): SubagentRewireConfig {
		if (config.enabled && isInheritAllRewire(config)) {
			const previous = this.previous.get(sessionId);
			this.previous.delete(sessionId);
			return previous ? { ...previous } : { ...config, enabled: false };
		}
		this.previous.delete(sessionId);
		this.previous.set(sessionId, { ...config });
		while (this.previous.size > 32) {
			this.previous.delete(this.previous.keys().next().value!);
		}
		return { ...config, enabled: true, inherit: false, inheritAll: true, model: currentModel ?? config.model };
	}
}
