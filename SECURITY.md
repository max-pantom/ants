# Ants security model

Ants is a single-user, local-first agent host. It has no telemetry and needs no Ants cloud account.

## Threat model

Ants protects the owner from accidental cross-agent transcript access, unapproved consequential tool calls, secret leakage into logs, and unexpected public-network access while a restrictive privacy mode is active. It does not protect a compromised operating-system account, a malicious plugin the owner installed, or arbitrary shell commands the owner approved.

## Enforced in code

- The server binds to loopback by default, rejects foreign hosts, and requires a session for its API.
- Each agent's chat and memory are queried by its own id. Tools are limited by an explicit per-agent allowlist.
- Declared send, spend, delete, and post actions pause for a local approval. Model text cannot grant approval.
- Secret values are stored outside the database with owner-only permissions, withheld from ordinary tools, and redacted from transcripts and logs.
- Fully local and self-hosted privacy modes block public-network model calls, HTTP tools, and browser navigation. Hybrid permits them.
- Model calls, tool calls, and network-policy decisions are written to the local audit log.

## Conventions, not sandboxes

Plugins run in the Ants process. The shell tool can reach the host after approval. Agents currently share one workspace and one browser profile, so separate agents are not security boundaries. Tool manifests and prompt instructions help constrain behavior but are not process isolation.

## Not implemented yet

Chats, memory, and secret files are not encrypted by Ants at rest. Use full-disk encryption and protect the data directory. Per-agent containers or VMs, isolated browser profiles, payload previews for every connector, signed skill packages, and recovery-safe user-held encryption keys are v2 work still to do.

## The owner's part

Review approval payloads, install only plugins you trust, keep the host patched, use disk encryption and backups, and treat Hybrid mode as permission for selected data to reach the configured provider or destination.
