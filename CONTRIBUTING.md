# Contributing

ObservMe is a Pi extension for OpenTelemetry-based observability of Pi agent sessions. See `specs/project-definition-brief.md`, `specs/spec-architecture.md`, and `specs/spec-guidelines.md` before implementing features, and follow `specs/spec-tasks.md` one checkbox at a time.

## Development setup

This project requires Node.js `>=22.19.0`.

```bash
npm install
npm run validate
```

Useful commands:

```bash
npm run typecheck
npm run test
npm run check:pack
pi --no-extensions -e .
```

## Pull requests

- Keep changes focused and explain user-visible behavior.
- Update README/docs/examples when commands, tools, settings, packaging, or security behavior changes.
- Run `npm run validate` before requesting review, or explain why it could not be run.
- Do not commit secrets, local `.pi/` state, generated package tarballs, `node_modules/`, or machine-local paths.
- If `docs/reference/` and any implementation detail disagree, update the implementation to match the production docs, not the other way around.

## Security expectations

Pi extensions run with the user's local permissions. Treat changes that execute shell commands, read files, write files, or call the network as security-sensitive and document the behavior. See `SECURITY.md` and `docs/reference/06-security-privacy-redaction.md`.
