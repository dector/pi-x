import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionDir, sessionId } from "./worker.ts";

export interface WorkerModel { provider: string; id: string }

/** Defaults are process-local; each thread's first assignment lives beside its session. */
export class ModelAssignments {
	private assigned = new Map<string, WorkerModel | null>();
	constructor(private readonly directory: () => string = sessionDir) {}

	resolve(root: string, threadId: string, current: () => WorkerModel | undefined): WorkerModel | undefined {
		const id = sessionId(root, threadId);
		if (this.assigned.has(id)) return this.assigned.get(id) ?? undefined;
		const dir = this.directory();
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${createHash("sha256").update(id).digest("hex")}.model.json`);
		let model: WorkerModel | null;
		if (fs.existsSync(file)) {
			const record = JSON.parse(fs.readFileSync(file, "utf8"));
			model = record.model;
			if (model !== null && (!model || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id)) {
				throw new Error(`Invalid Gust model assignment: ${file}`);
			}
		} else {
			// Legacy sessions already have model state. Do not override it with today's default.
			const legacy = fs.readdirSync(dir).some((name) => name.endsWith(`_${id}.jsonl`) || name === `${id}.jsonl`);
			model = legacy ? null : current() ?? null;
			if (!legacy && !model) throw new Error("Gust: no foreground chat model. Select one with /px:gust model before starting new threads.");
			fs.writeFileSync(file, JSON.stringify({ sessionId: id, model }) + "\n", { flag: "wx", mode: 0o600 });
		}
		this.assigned.set(id, model);
		return model ?? undefined;
	}
}
