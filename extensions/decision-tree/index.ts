import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDecisionTreeCommands } from "./pi/commands";
import { registerDecisionTreeTools } from "./pi/tools";

export default function decisionTreeExtension(pi: ExtensionAPI): void {
	registerDecisionTreeTools(pi);
	registerDecisionTreeCommands(pi);
}
