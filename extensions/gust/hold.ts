import type { ReloadClient, ReloadTarget } from "./gust.ts";

export interface HoldSettings {
	enabled: boolean;
	ownedTarget?: ReloadTarget;
}

// Pi replaces extension instances on /new and /reload. Only the opt-in lives
// across those replacements; no session files or disk settings are involved.
export function processHoldSettings(): HoldSettings {
	const host = globalThis as typeof globalThis & { __piXGustHold?: HoldSettings };
	return host.__piXGustHold ??= { enabled: false };
}

export class ReloadHold {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private client: ReloadClient, readonly settings: HoldSettings) {}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work);
		this.queue = next.catch(() => {});
		return next;
	}

	private async pause(target: ReloadTarget): Promise<void> {
		if (!this.settings.enabled) return;
		if (this.settings.ownedTarget) {
			if (await this.client.status(this.settings.ownedTarget) === "paused") return;
			// A lost resume reply (or manual resume) must not skip the next hold.
			this.settings.ownedTarget = undefined;
		}
		if (await this.client.status(target) === "paused") return;
		// Retain ownership even if the reply is lost: Gust may have applied the
		// pause already. Settle/toggle/shutdown will still attempt to release it.
		this.settings.ownedTarget = { ...target };
		await this.client.pause(this.settings.ownedTarget);
	}

	private async release(): Promise<void> {
		if (!this.settings.ownedTarget) return;
		await this.client.resume(this.settings.ownedTarget);
		this.settings.ownedTarget = undefined;
	}

	toggle(target: ReloadTarget, working: boolean): Promise<boolean> {
		return this.serial(async () => {
			if (this.settings.enabled) {
				this.settings.enabled = false;
				await this.release();
			} else {
				// Validate availability without pausing an idle project.
				await this.release();
				await this.client.status(target);
				this.settings.enabled = true;
				if (working) await this.pause(target);
			}
			return this.settings.enabled;
		});
	}

	start(target: ReloadTarget): Promise<void> {
		return this.serial(() => this.pause(target));
	}

	settle(shouldRelease: () => boolean = () => true): Promise<void> {
		return this.serial(async () => {
			if (shouldRelease()) await this.release();
		});
	}

	shutdown(quit: boolean): Promise<void> {
		return this.serial(async () => {
			if (quit) this.settings.enabled = false;
			await this.release();
		});
	}
}
