# Ants

Named agents with their own chats, memory, and screens, on one machine you own.

You message an agent by name and it replies. Each agent has its own transcript, its own memory, its own skills and routine, and its own screen: a real browser page you can watch while it works. They share the machine: the files, the browser's cookie jar and saved logins, and the installed tools. A coordinator can hand work to an agent or spawn a short-lived worker. Anything that sends, spends, deletes, or posts waits for your yes in the chat.

It's one Node process. Locally it binds `127.0.0.1` and opens your browser, and that is the app. On a server it's the same binary behind a password.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
npx playwright install chromium
npm run build
node bin/ants.js
```

That prints a link with a one-time token and opens it. The token is how this browser gets a session. Other local processes and web pages can't drive Ants without it, and the server only answers to `localhost` hosts.

First run already has one agent, Ada, so you start with a message rather than a form. Add a model under **Settings → Models**.

For development, `npm run dev` runs the server with reload and Vite on port 5173. Data then lives in `.ants-dev/` in the repo.

## Models

An agent stores a provider id and a model id. Leave them empty and it uses the host default.

| Provider | How it authenticates |
| --- | --- |
| OpenAI | API key |
| xAI | API key, or the optional subscription device login |
| OpenAI-compatible | Any base URL, key optional. Point it at `http://127.0.0.1:11434/v1` (Ollama) for a local model. |
| ChatGPT plan (official preview) | OpenAI OAuth; eligible Plus or Pro plan usage |

**Local endpoints and API keys** are the stable paths. Fully local mode permits only loopback endpoints; switch to Hybrid before contacting a public provider.

**Continue with ChatGPT** is an optional official preview for eligible open-source, locally hosted apps. It uses OpenAI's [documented OAuth flow](https://developers.openai.com/siwc/token-sharing-open-source), not browser cookies or a replayed chatgpt.com session. It needs no client secret and no API key. The first sign-in registers this install with `client_id=dynamic_agent_client`, and OpenAI issues a `client_id` that Ants keeps. A stable `ext_agent_host_id` is generated on first launch and stored in `secrets/chatgpt-host.json`. Calls go to the Responses API with `store: false` and `stream: true`. This permission does not expose ChatGPT conversations or account context.

OpenAI's plan limits apply. Ants treats plan usage as spend: each agent asks once per session before its first call, then a user-configurable local daily safety cap applies (Settings → Agents). Requests come from this machine for you only. Ants never pools the token or proxies it to other tools.

## Privacy modes

- **Fully local** is the default on a local install. Only loopback model endpoints, HTTP requests, and browser navigation are allowed.
- **Self-hosted** is the default for `ants serve` and keeps the same public-network block for agent activity on that host.
- **Hybrid** lets the selected model and tools contact public-network destinations. Chats, memory, secrets, and the audit log remain in the local data directory.

Settings → Privacy includes the active mode, a local audit log, a portable export, and a wipe control. Ants sends no telemetry and requires no cloud account. Read [SECURITY.md](SECURITY.md) before enabling powerful plugins or shell access.

Ants does **not yet encrypt its database or secret files at rest**. Owner-only filesystem permissions and redaction are enforced, but full-disk encryption is currently the protection for a stolen disk. This limitation is shown in the UI rather than hidden.

**xAI device login** is an RFC 8628 device-code flow against `auth.x.ai` for SuperGrok or X Premium+. Inference still goes to `api.x.ai/v1`. Some tiers get a 403 there even after a good login. When that happens, Ants says so in Settings and in the chat and falls back to your xAI key once. It never retries in a loop. The device flow needs a public OAuth client id: set it in Settings or `ANTS_XAI_CLIENT_ID`.

## On a server

```bash
node bin/ants.js serve --data /var/lib/ants
```

- It binds `127.0.0.1:4747` even on a server. Put a reverse proxy in front for a public name (`deploy/Caddyfile`).
- First boot prints a six-digit setup code in the log. Open the site, enter the code, and choose the password. To skip the code, set `ANTS_PASSWORD` once. `node bin/ants.js password <new>` resets the password from a shell.
- Run it as a service (`deploy/ants.service`) so agents keep working while your laptop is closed.
- **ChatGPT on a server:** sign in on the machine with your browser, then copy only the credential file. Ants has no remote callback.

  ```bash
  scp ~/.ants/secrets/chatgpt-auth.json you@server:/var/lib/ants/secrets/
  ```

  Don't copy `chatgpt-host.json`. Each install keeps its own host id.

## Where things live

`~/.ants` locally, or `/var/lib/ants` on a server:

```
ants.db              agents, messages, memories, approvals, routines, groups
secrets/             0700. One 0600 JSON file per secret. Never a database column.
agents/<id>/skills/  saved procedures, one markdown file each
agents/<id>/plugins/ plugins installed for this agent only
agents/<id>/shots/   screenshots shown in its chat
browser/             the one Playwright profile: the shared cookie jar
plugins/             plugins installed for the whole host
workspace/           the shared folder agents work in
```

Before any log line and before any message insert, text goes through a redactor that knows every value in `secrets/`. The `files` tool refuses the secrets folder and the database. `shell` can reach anything, which is why every command waits for your yes, and it doesn't pass the host's key environment variables to the commands it runs.

**One machine, shared on purpose.** Agents share files, cookies, and tools, which is why a handoff never starts with "sign in again". A secret you put on this machine is visible to every agent. Separate agents are not a sandbox. Only the chat, the memory, and the screen are kept apart.

## How it works

`server/loop.ts` is the product, and it stays readable:

1. Append the user message.
2. Build the prompt from that agent's role, memory, and transcript.
3. Call the model with only that agent's tool allowlist.
4. If the model calls a tool, run the gate, then the tool, then append the result.
5. Repeat until it returns text, streaming that text into the chat.

A gated tool inserts an approval message and the turn stops. Nothing waits in memory. When the chat receives yes (the button, or typing "yes"), the turn runs again and picks up the call where it stopped. Any other reply counts as no.

**Agents.** Creating one takes a name and a role. Each one gets its own thread `a:<id>`. No query reads another agent's thread, and that includes the coordinator.

**Coordinator.** An agent row with `handoff`, `message_agent`, and `spawn`, and no shell. `handoff` appends to the target's chat and runs it, and the reply is posted back. `message_agent` leaves a note without taking the turn. `spawn` creates a temporary worker with a deadline and a copy of an explicit tool list. It runs the worker, posts the result, and deletes the worker's transcript. If a worker hits a gated tool, it asks in its parent's chat.

**Screens.** There is one persistent Chromium profile for the machine, so logins are shared, and each agent gets its own page in it, launched lazily. The chat's Screen button streams a live view over CDP screencast with click ripples and typing captions. Hiding the view doesn't stop the work. If Playwright's own Chromium can't be installed (macOS 13, for example), Ants falls back to Chrome, Edge, an older Chromium in the Playwright cache, or `ANTS_CHROMIUM`.

**Skills and routines.** A skill is *how*: a markdown file with steps, decision rules, output format, and the approval boundary, which the agent writes with `skill_save` after a task worked. Run one with `/name` in the chat. A routine is *when*: one cron per agent, pointing at a skill or a standing instruction. It posts into the chat and still stops at gated tools.

**Groups.** A group thread holds two to six agents plus you. Use `@name` to choose who answers. Otherwise the first member does, and members can hand off to each other. A group can't read anyone's one-to-one chat.

**Copy as template.** Copies the role, skills, routine (paused), plugins, and allowlist. Never the transcript or the memory.

**Plugins.** A plugin is a folder (see `plugins/README.md`). `files`, `shell`, and `fetch` ship as folders loaded through the same loader as the `hello` example, so the loader is the real path. Only declared tools register.

## Tests

```bash
npm test
```

This runs the real server against a scripted OpenAI-compatible model (`test/mock-model.ts`). It covers separate transcripts, shared files, redaction, the approval gate, memory, handoff, spawn, plugin isolation, groups, skills, and templates. `npx tsx test/run-mock.ts` starts the same mock model on port 4999, so you can try the UI without a key.

## Not in v1

A plugin marketplace, mobile apps, a native desktop shell, multi-user teams, demonstration recording, and vector search over memory.

## License

Apache-2.0.
