# Demo script for another agent: Processes and Subagents panels

Your job is to give the user a **live, guided demo** of the uncommitted panel migration in this repository. Do not edit files, install extensions without permission, or commit. Let the user press `Alt+P` and `Alt+Shift+P` themselves; pause for their feedback at each checkpoint.

## Before starting

1. Check that the running Pi session has the updated `panels`, `proc`, and `subagent` extensions loaded. If the demo does not show the new widgets, ask the user to install/reload the local changes; do not silently install or overwrite their extensions. `./install` is interactive and has a Herdr safety check.
2. Use a unique process name (for example `panel-demo-<short-id>`). Remember it so you clean up **only your demo process**. Do not stop or forget the user's other processes.
3. Explain that widgets appear **above the editor**, not in the footer. When they have content, **both** panels start as one-line collapsed summaries. Neither auto-expands when new work starts. After a selected panel disappears, all panels stay collapsed until the user presses a cycle key.

## Demo A: Processes alone

1. Start a harmless, long-enough demo process with the `proc` tool, using your unique name. Example `command`: `for i in $(seq 1 90); do printf 'panel demo tick %s\n' "$i"; sleep 2; done`. It runs for up to three minutes without changing files. Tell the user the process name.
2. Ask the user to confirm the **collapsed Processes** line is visible above the editor and **no proc row** appears in the status-bar footer.
3. Ask the user to press `Alt+P` once, observe **Processes expanded** (process name, PID, running state and elapsed time), and report what they see. With no active subagent, another press collapses all, and the next expands Processes again. If another subagent is already active, use the two-panel sequence below instead.
4. Optionally use `proc` `status` or `logs` for the demo process to show the underlying process is real; do not claim the widget itself is interactive.

## Demo B: Both panels and the cycle

1. While the demo process is running, start a **read-only async** `subagent` task (for example, ask `worker-fast` to inspect the local panel READMEs and summarize the cycling rules; explicitly forbid file edits). Do not run a blocking task: the user needs a chance to press keys while it is active. If it finishes too quickly, say so and offer another useful read-only task instead of faking an active agent.
2. When both panels have content in a fresh session, confirm **both are collapsed**. Have the user press `Alt+P` one press at a time, pausing after each press and checking the result. From all collapsed, the sequence is:
   - **Subagents expanded**, Processes collapsed;
   - **Processes expanded**, Subagents collapsed;
   - **all collapsed** (both one-line summaries);
   - back to **Subagents expanded**.
   Start wherever the current selection is; do not assume a fresh session. Only one panel should be expanded at any time. Subagents must stay **above** Processes through every expansion/collapse and while elapsed times refresh; they must not swap places.
3. Ask the user to press `Alt+Shift+P` to cycle in the opposite direction: from Subagents expanded to all collapsed, then Processes expanded, then Subagents expanded. This combination needs a terminal that reports the modifier reliably; if it does not work, note the terminal and report it rather than claiming the cycle is broken.
4. If the subagent finishes, its widget disappears and `Alt+P` skips it. Do not describe this as a failure. If the expanded panel disappears, all panels collapse until the next `Alt+P`.
5. Optional: while an agent is still active, open its Watch view with `/px:agents`. Watch temporarily suppresses the Subagents widget. If the user changes panel selection during Watch, closing Watch must **not undo** that choice. Skip this if the agent has already finished.

## Cleanup and report

1. Stop **only** the demo process via `proc` (`action: "stop"`, the remembered name). Confirm its state. Do not use `kill` unless a normal stop fails. The exited process may remain in the widget for about 60 seconds, then disappear automatically; `forget` it if appropriate after it exits.
2. Tell the user exactly which checkpoints passed or failed, including any keypress/terminal issues. Do not commit. Leave unrelated running processes and subagents untouched.
