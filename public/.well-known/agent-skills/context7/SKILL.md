---
name: use-context7
description: Use Context7 through Realmroot Toolbox to resolve a software library and retrieve current, task-relevant documentation without handling Context7 credentials.
---

# Use Context7

Use the `realmroot` command so every Context7 request runs as the Agent with
controller-approved authority. Never call Context7 with a user token or ask the
user for an API key.

Before the first operation, run:

```bash
realmroot toolbox context7
```

If the command reports missing access, request the exact
`documentation:read` scope and continue after controller approval.

Resolve the library before requesting documentation:

1. Call `GET /libraries` with `libraryName` and the current task in `query`.
2. Select the best matching `id` from the ranked `results`; do not invent or
   infer an identifier when multiple matches exist.
3. Call `GET /documentation` with the selected `libraryId`, a specific `query`,
   and `type=json` when structured snippets are useful or `type=txt` for prose.

Keep each documentation query focused on one concrete question. Repeat the
library lookup when the package or ecosystem changes.
