# Repository Conventions

Observed in `ai-agent-context` by ai-agent-context (schema v1).

Each statement is a counted observation over the repository, not a guess: the confidence and the
evidence behind it are listed. Statements marked `config` come from declared configuration files.

## Documentation

- Repository documentation starts at `README.md`. _(confidence 0.90, observed)_
  - evidence: `README.md` — top level README present

## Error handling

- Domain errors are declared as classes extending the built-in `Error` (1 classes). _(confidence 0.85, observed)_
  - evidence: `packages/core/src/errors.ts` — class AgentContextError extends Error (line 26)

## Exports

- Modules use named exports rather than default exports (434/434 exported symbols are named). _(confidence 0.85, observed)_
  - evidence: `packages/cli/src/cli.ts` — exports CLI_NAME
  - evidence: `packages/cli/src/cli.ts` — exports CLI_VERSION
  - evidence: `packages/cli/src/cli.ts` — exports CliIo

## Imports

- External dependencies are imported before internal modules (44/50 files). _(confidence 0.75, observed)_
  - evidence: `<repository>` — import order observed across files that import both kinds of modules
- Type-only dependencies use `import type` (59/119 files). _(confidence 0.80, observed)_
  - evidence: `<repository>` — import type / export type statements detected

## Languages

- Implementation mixes TypeScript (117 files) and JavaScript (13 files). _(confidence 0.90, observed)_
  - evidence: `<repository>` — languages are derived from file extensions, not from content guessing

## Naming

- Classes use PascalCase (27/27 declarations). _(confidence 0.95, observed)_
  - evidence: `packages/cli/src/ui/console.ts` — class "ConsoleOutput" uses PascalCase
  - evidence: `packages/core/src/adapters/filesystem/fs-adapter.ts` — class "FileSystemAdapter" uses PascalCase
  - evidence: `packages/core/src/adapters/filesystem/sensitive.ts` — class "SensitivePathFilter" uses PascalCase
- Functions use camelCase (383/386 declarations). _(confidence 0.95, observed)_
  - evidence: `packages/cli/src/cli.ts` — function "appendFlag" uses camelCase
  - evidence: `packages/cli/src/cli.ts` — function "parseArguments" uses camelCase
  - evidence: `packages/cli/src/cli.ts` — function "flagString" uses camelCase
- Source files use camelCase (79/100 files). _(confidence 0.91, observed)_
  - evidence: `packages/cli/src/bin.ts` — file name uses camelCase
  - evidence: `packages/cli/src/cli.ts` — file name uses camelCase
  - evidence: `packages/cli/src/commands/clean.ts` — file name uses camelCase
- Type aliases use PascalCase (34/34 declarations). _(confidence 0.95, observed)_
  - evidence: `packages/cli/src/commands/migrate.ts` — type "MigrationState" uses PascalCase
  - evidence: `packages/core/src/adapters/language/ts-js/lexer.ts` — type "TokenType" uses PascalCase
  - evidence: `packages/core/src/adapters/language/types.ts` — type "Signal" uses PascalCase
- TypeScript interfaces use PascalCase (164/164 declarations). _(confidence 0.95, observed)_
  - evidence: `packages/cli/src/cli.ts` — interface "CliIo" uses PascalCase
  - evidence: `packages/cli/src/cli.ts` — interface "ParsedArguments" uses PascalCase
  - evidence: `packages/cli/src/cli.ts` — interface "CliCommandContext" uses PascalCase

## Tests

- Tests live in a dedicated test directory (30/32 test files). _(confidence 0.80, observed)_
  - evidence: `packages/cli/test/cli.test.ts` — test located in a central tests directory
  - evidence: `packages/cli/test/public-api.lock.json` — test located in a central tests directory

## Toolchain

- Dependencies are managed with npm (repository signal). _(confidence 0.80, config)_
  - evidence: `package-lock.json` — lockfile present (repository signal only, not proof of runtime usage)
  - evidence: `package.json` — package.json declares packageManager "npm@11.15.0"
- The repository is a npm workspace monorepo (packages/cli, packages/core, packages/mcp). _(confidence 0.95, config)_
  - evidence: `package.json` — workspaces: packages/cli, packages/core, packages/mcp
- The repository is configured as ESM (`"type": "module"` in package.json). _(confidence 0.90, config)_
  - evidence: `package.json` — "type": "module"
- TypeScript strict mode is enabled (1 tsconfig file(s)). _(confidence 0.95, config)_
  - evidence: `tsconfig.base.json` — "strict": true

---

Machine readable form: `.agent/conventions.json` (schema v1).
