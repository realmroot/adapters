---
name: use-todoist
description: Use Todoist through Realmroot Toolbox to list the user's active projects and tasks with controller-approved, read-only Agent authority.
---

# Use Todoist

Use the `realmroot` command so every Todoist request runs as the Agent with
controller-approved authority. Never ask the user for a Todoist API token.

Before the first operation, run:

```bash
realmroot toolbox todoist
```

If the command reports missing access, request only the `tasks:read` scope and
continue after controller approval.

Use the published resources as follows:

1. Call `GET /projects` to discover active projects. Preserve `next_cursor`
   when another page is needed.
2. Call `GET /tasks` to list active tasks. Prefer narrowing by `project_id`,
   `section_id`, `parent_id`, `label`, or explicit `ids` when the task permits.
3. Follow cursor pagination until `next_cursor` is null or enough information
   has been gathered.

This Resource is read-only. Do not infer that creating, completing, updating,
or deleting Todoist data is available.
