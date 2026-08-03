# Decision Tree Extension — High-Level Milestones

## Milestone 1: Core Model

Define the v1 decision tree domain model, file schemas, enums, validation rules, and core invariants.

## Milestone 2: Persistence Boundary

Create the persistence interface and test-friendly in-memory implementation.

## Milestone 3: File Persistence

Implement project-local file persistence under `docs/.decisions/`, including initialization and discovery.

## Milestone 4: Core Service

Implement tree/session operations, mutations, path computation, item reads, overview reads, note updates, and unresolved queries.

## Milestone 5: Core Test Coverage

Cover validation, persistence, mutation behavior, active context behavior, overview behavior, note deletion, and unresolved ranking.

## Milestone 6: Pi Tool Adapter

Register the visible `dt_*` tools and map them to core service operations.

## Milestone 7: `/dt` Commands

Add minimal human commands for init, status, list, and select.

## Milestone 8: Documentation and Smoke Test

Document usage, storage layout, tool behavior, and run a basic end-to-end workflow in a project.
