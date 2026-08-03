import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDecisionTreeTools } from "./pi/tools";

export default function decisionTreeExtension(pi: ExtensionAPI): void {
	registerDecisionTreeTools(pi);
}
