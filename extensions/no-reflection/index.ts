import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_VALUES = new Set(["false", "no", "n", "0"]);

function isEnabled(): boolean {
  const value = process.env.PI_NO_REFLECTION;
  if (value === undefined) return true;
  return !DISABLED_VALUES.has(value.trim().toLowerCase());
}

function stripPiDocumentationBlock(prompt: string): string {
  const lines = prompt.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (!skipping && line.startsWith("Pi documentation (read only when")) {
      skipping = true;
      continue;
    }

    if (skipping) {
      if (line.trim() === "") {
        skipping = false;
      }
      continue;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (!isEnabled()) return;

    return { systemPrompt: stripPiDocumentationBlock(event.systemPrompt) };
  });
}
