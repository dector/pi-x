export interface InterruptConfirmationDependencies {
	/** Stable identity for the current cancellable operation, or undefined while idle. */
	getOperationToken: () => object | undefined;
	confirm: () => Promise<boolean>;
}

/**
 * Coalesces interrupt requests while a confirmation is open. The operation
 * identity is checked again after confirmation so a late "yes" cannot cancel
 * newer or already-settled work.
 */
export class InterruptConfirmationGuard {
	private pending = false;

	constructor(private readonly dependencies: InterruptConfirmationDependencies) {}

	/** Returns true when the interrupt was consumed by the guard. */
	request(interrupt: () => void): boolean {
		const operationToken = this.dependencies.getOperationToken();
		if (!operationToken) return false;
		if (this.pending) return true;

		this.pending = true;
		void this.confirmAndInterrupt(operationToken, interrupt);
		return true;
	}

	private async confirmAndInterrupt(operationToken: object, interrupt: () => void): Promise<void> {
		try {
			const confirmed = await this.dependencies.confirm();
			if (confirmed && this.dependencies.getOperationToken() === operationToken) interrupt();
		} catch {
			// Dialog teardown (reload/shutdown) is equivalent to declining.
		} finally {
			this.pending = false;
		}
	}
}

/** Preserve pi's native, dynamically routed interrupt behavior after confirmation. */
export function createProtectedInterrupt(
	interruptWithoutConfirmation: () => void,
	confirmation: InterruptConfirmationGuard,
): () => void {
	return () => {
		if (confirmation.request(interruptWithoutConfirmation)) return;
		interruptWithoutConfirmation();
	};
}
