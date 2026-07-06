# Template Structure Guide

Use this file as the note for future Pi extension projects. Replace template names as soon as the new extension has a real purpose.

## Recommended file layout

```text
src/
├── extension.ts          # only imports modules and registers them
├── commands/             # slash-command modules
├── tools/                # LLM-callable tool modules
├── events/               # lifecycle/input/tool/model event hooks
├── ui/                   # custom TUI components or renderers, when needed
├── config/               # config loading and validation, when needed
├── types.ts              # shared domain types, when needed
└── utils/                # pure helpers with unit tests
```

## How to add multiple files by purpose

1. Pick the folder by behavior:
   - `commands/` for `/command` handlers.
   - `tools/` for `pi.registerTool()` definitions.
   - `events/` for `pi.on(...)` hooks.
   - `ui/` for renderers, widgets, and custom components.
   - `config/` for settings parsing and environment handling.
   - `utils/` for reusable pure helpers.
2. Export one registration function from each feature module, for example `registerReviewTool(pi)`.
3. Import and call that registration function from `src/extension.ts`.
4. Keep project names in constants (`src/constants.ts`) so renaming does not require hunting through every file.
5. Add tests for pure helpers and package metadata under `test/`.

## Pi extension conventions

- Do not start long-lived processes, file watchers, timers, or sockets directly in the extension factory.
- Start session-scoped resources from `session_start`, a command, or a tool.
- Clean up resources in `session_shutdown`.
- Use `promptSnippet` and `promptGuidelines` on tools when the agent needs to know when to call them.
- If a custom tool edits files, use Pi's file-mutation queue helpers from `@earendil-works/pi-coding-agent`.
- Keep Pi core packages in `peerDependencies` with `"*"`; put non-Pi runtime packages in `dependencies`.
- Run `npm run lint` after adding TypeScript or development script files so ESLint catches unused symbols and import-style drift.

## Rename points for a new project

- `package.json` → `name`, `description`, URLs, keywords, and `pi.extensions` if the entry point moves.
- `src/constants.ts` → display name and status key.
- `src/commands/*` → command names and descriptions.
- `src/tools/*` → tool names, descriptions, schemas, snippets, and guidelines.
- `.github/*`, `SECURITY.md`, `CHANGELOG.md`, and `README.md` → public project wording.
