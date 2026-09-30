import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const APPROVAL_INVESTIGATION_LOG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"extensions",
	"safe-mode",
	"investigations.jsonl",
);

export interface ApprovalInvestigationRecord {
	timestamp: string;
	mode: string;
	outerAccess: boolean;
	toolName: string;
	command: string;
	cwd: string;
	userChoice: string;
}

export async function appendApprovalInvestigation(
	record: Omit<ApprovalInvestigationRecord, "timestamp">,
	filePath = APPROVAL_INVESTIGATION_LOG_PATH,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	const entry: ApprovalInvestigationRecord = { timestamp: new Date().toISOString(), ...record };
	await appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}
