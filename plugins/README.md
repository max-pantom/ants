# Plugins

A plugin is a folder with two files:

- `plugin.json`: `name` (lowercase, dashes ok), `description`, optional `main` (default `index.mjs`), and `tools`: each with `name`, `description`, `parameters` (JSON Schema), and optional `gate`.
- `index.mjs`: exports `tools`, an object of async functions `(args, ctx) => string | { text, image }`.

Tools register as `<plugin>_<tool>`, for example `files_read`. Only declared tools are registered; anything else the module exports is ignored.

`gate: true` means every call waits for the user's yes in the chat. `gate: { "when": "consequential" }` asks only when that boolean argument is true. Use a gate for anything that sends, spends, deletes, or posts.

Where plugins load from:

- `plugins/` in this repo: the built-ins (`files`, `shell`, `fetch`) and the `hello` example.
- `~/.ants/plugins/<name>/`: installed for the whole host.
- `~/.ants/agents/<id>/plugins/<name>/`: installed for one agent only.

Loading a plugin does not give it to anyone. Each agent has an allowlist, edited in Settings → Agents.
