# @agentrysh/shared

Shared types, error envelopes, credential parsing, and control-plane utilities used by [Agentry](https://github.com/agentry-sh/agentry).

Most users don't need to install this directly. Pull it in if you're building a custom Agentry integration and want the same primitives.

## Exports

- `AgentryError`, `errors` — typed error envelope used across the API
- `CreateProjectRequestSchema`, automation schemas — control-plane request contracts
- `uuidv7`, `sha256Hex` — small id/crypto helpers
- Type-only exports: `AgentryConfig`, `CaseDetail`, `CaseSummary`, `StackFrame`, etc.

## Install

```bash
npm install @agentrysh/shared
```

## License

MIT
