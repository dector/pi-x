import readline from "node:readline";

const mode = process.argv[2] ?? "normal";
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
	const command = JSON.parse(line);
	if (command.type === "prompt") {
		if (mode === "exit") process.exit(2);
		output({ id: command.id, type: "response", command: "prompt", success: true });
		output({ type: "agent_start" });
		output({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } },
			},
		});
		output({ type: "agent_end", willRetry: false, messages: [] });
	} else if (command.type === "ping") {
		output({ id: command.id, type: "response", command: "ping", success: true, data: command.value });
	} else if (command.type === "abort") {
		output({ id: command.id, type: "response", command: "abort", success: true });
		output({ type: "agent_end", willRetry: false, messages: [] });
	}
});

rl.on("close", () => process.exit(0));
