---
description: Full implementation workflow - scout-fast gathers context, planner-fast creates plan, worker-fast implements
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout-fast" agent to find all code relevant to: $@
2. Then, use the "planner-fast" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "worker-fast" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
