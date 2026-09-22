import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";

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

/** Maps raw key input to a confirmation outcome; `undefined` means "ignore". */
export function resolveInterruptConfirmationInput(data: string): boolean | undefined {
	if (data === "y" || data === "Y") return true;
	if (data === "n" || data === "N" || matchesKey(data, "escape")) return false;
	return undefined;
}

/**
 * Title-less confirmation dialog for interrupting the active agent.
 *
 * Renders a red message plus an explicit `y`/`n` explanation. `Enter` is
 * intentionally ignored so an accidental keypress cannot stop the operation.
 */
export async function showInterruptConfirmation(ctx: ExtensionContext): Promise<boolean> {
	if (!ctx.hasUI) return false;

	return ctx.ui.custom<boolean>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
		container.addChild(new Text(theme.fg("error", theme.bold("Stop the current agent operation?")), 1, 1));
		container.addChild(new Text(theme.fg("dim", "[y] yes, stop it   [n] no, keep running"), 1, 1));
		container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const resolution = resolveInterruptConfirmationInput(data);
				if (resolution === undefined) return;
				done(resolution);
			},
		};
	});
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
