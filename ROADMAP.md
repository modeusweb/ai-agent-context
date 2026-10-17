# Roadmap

## Назначение документа

Документ описывает целевую эволюцию `ai-agent-context` — локального Git-native context layer для AI coding agents. Roadmap не является жёстким обещанием дат: приоритеты могут меняться по результатам пользовательских исследований, benchmark и обратной связи.

## Продуктовая цель

Дать coding agent перед изменением кода компактную, проверяемую и версионируемую карту репозитория:

- архитектура и ответственность модулей;
- внутренние и внешние зависимости;
- entry points и публичный API;
- conventions и архитектурные решения;
- история изменений и потенциальное влияние изменений.

Основные принципы развития:

- **Local-first** — исходный код не покидает машину без явного действия пользователя.
- **Deterministic** — одинаковое состояние репозитория даёт воспроизводимый результат.
- **Evidence-based** — выводы сопровождаются источниками и уровнем уверенности.
- **Agent-oriented** — контекст выбирается под конкретную задачу и бюджет токенов.
- **Git-native** — учитываются текущее состояние и история изменений.
- **Incremental** — повторный анализ не перечитывает неизменившиеся файлы.
- **Safe by default** — path traversal, symlink policy и sensitive files обрабатываются явно.

## Текущая база

Текущая версия пакетов: `0.5.0`.

Уже реализованы:

- ядро анализатора без runtime-зависимостей;
- CLI: `init`, `scan`, `status`, `explain`, `context`, `task`, `impact`, `search`, `diff`, `history`, `revision-diff`, `verify`, `clean`;
- MCP stdio-сервер: 13 tools, Resources, Prompts, строгая валидация аргументов;
- incremental scanning и content-addressed parse cache;
- knowledge graph, определение модулей, entry points, cycles, layering diagnostics;
- определение dependencies, conventions и decisions с confidence и evidence;
- temporal context: `getModuleHistory`, `getRevisionDiff`, `getRevisionSnapshot`;
- directory-scoped `explain`/`impact` вместо молчаливого расширения до родительского модуля;
- path traversal отклоняется, а не схлопывается;
- Git activity signals, детерминированная сериализация в `.agent/`, secret filtering;
- workspace-поддержка npm workspaces;
- 131 tests, CI на Node 20/22/24 × Linux/Windows/macOS.

## Приоритеты

- **P0** — измеримая польза и доверие к цифрам. Метрики качества публикуются и воспроизводятся.
- **P1** — релевантность контекста задаче.
- **P2** — temporal context, зрелый MCP, enterprise controls.
- **P3** — экосистема и интеграции после подтверждённого спроса.

**Правило приоритета.** Ни один новый анализатор не попадает в релиз, пока не
показан измеримый baseline и regression coverage на реальном коде. Расширение
поверх неверного графа зависимостей делает продукт хуже, а не больше: v0.5
начался с исправления резолвера, а не с новых фич.

---

# v0.3 — Agent-ready context (completed)

**Цель:** превратить полный repository context в компактный контекст, который AI agent может эффективно использовать для конкретной задачи.

**Реализовано:**

- `getTaskContext(task, options)` с bounded `maxModules` и optional `target`;
- `getChangeImpact(target, options)` с bounded `maxFiles`;
- CLI-команды `task` и `impact`;
- MCP tools `get_context_for_task` и `get_change_impact`;
- evidence для выбранных модулей и impact-срезов;
- regression coverage в CLI/MCP integration tests.

## Критерии готовности — выполнены

- агент получает релевантный контекст без ручного чтения большого числа файлов;
- пользователь может задать лимит контекста;
- каждый новый вывод объясним через evidence;
- все сценарии `init → scan → explain → diff` работают.

---

# v0.4 — Structural intelligence (completed)

**Цель:** повысить точность структурного анализа TypeScript/JavaScript.

**Реализовано:**

- расширенный extraction для re-exports, aliases, barrel files и conditional exports;
- определение entry points, включая package exports, CLI bin и HTTP routes;
- связи `test → module` и `entry point → module`;
- диагностика import cycles;
- layering violations с confidence и evidence;
- детерминированный резолвер импортов (корректность `..` исправлена в v0.5).

## Критерии готовности — выполнены

- false positives на динамических импортах и barrel files не регрессируют;
- impact analysis возвращает проверяемые evidence paths;
- версия проходит полный verify pipeline.

---

# v0.5 — Graph correctness (completed)

**Цель:** сделать Dependency Graph пригодным для решений, а не только для отображения.

Этот релиз — переоценка приоритетов. Аудит на реальном репозитории показал, что
резолвер не схлопывал `..`: 222 из 250 относительных импортов попадали в
`unresolved`, а вместе с ними пустели `get_dependents`, `get_change_impact` и
layering diagnostics. Ни один из 103 существовавших тестов этого не ловил —
в фикстурах не было ни одного импорта с `..`.

**Реализовано:**

- `..`-коллапс в `normalizeRelative`; невозможность замаскировать traversal под
  валидный in-repo путь;
- `escapesRoot`/`joinStrict` — явный отказ вместо молчаливого схлопывания;
- directory-scoped `explain`/`impact` с полем `scope`;
- Node built-ins ранжируются ниже объявленных пакетов;
- regression suite: `resolver.test.ts`, `explain.test.ts`;
- `tools/set-version.mjs` для единого источника версии;
- CI на Node 20/22/24 × Linux/Windows/macOS;
- `CONTRIBUTING.md`.

**Измеримый результат на собственном репозитории:**

| Метрика | До | После |
| --- | --- | --- |
| Unresolved imports | 222 | 16 (только `dist/`, исключённый по умолчанию) |
| Module edges | 18 | 49 |
| Recall относительных импортов | 45,5% | 93,6% |
| Тестов | 103 | 131 |

## Критерии готовности — выполнены

- относительные импорты, поднимающиеся по дереву, разрешаются;
- traversal отклоняется с понятным diagnostic;
- `explain`/`impact` не расширяются молча до родительского модуля;
- каждый пункт покрыт тестом, который падал бы до исправления.

---

# v0.6 — Measurable value (in progress)

**Цель:** заменить лозунг «компактный контекст» измеренными цифрами, которые
можно воспроизвести.

Причина задержки: пока половина графа зависимостей была пустой, любое
сравнение объёма контекста сравнивало бы шум с шумом.

## Возможности

- Benchmark на реальных публичных репозиториях, а не только на синтетических fixtures.
- Метрики качества с baseline: import resolution rate, entry-point precision,
  dependency recall на размеченном наборе.
- Token-budget бенчмарк: `explain <module>` против чтения всех файлов модуля.
- Incremental-scan бенчмарк на повторном проходе (сейчас `reused: 0`).
- Отчёт публикуется как артефакт CI, а не как локальный файл в репозитории.
- `detect` — команда, которая честно сообщает, чего анализатор не понял.

## Критерии готовности

- import resolution rate на реальных репозиториях измерим и опубликован;
- token-budget бенчмарк показывает выигрыш против наивного чтения;
- incremental path реально exercised в бенчмарке;
- benchmark воспроизводится одной командой в CI.

---

# v0.7 — MCP production readiness (in progress)

**Цель:** сделать MCP-пакет надёжным и удобным для реальных клиентов.

**Текущий срез:** реализованы Resources/Prompts, read-only stdio transport,
строгая pre-dispatch валидация по JSON Schema subset. Сервер пиннит
`2024-11-05`; поддержка negotiation актуальных версий протокола не сделана.

## Возможности

- Поддержка актуальных версий MCP protocol и совместимых clients.
- Request cancellation, timeouts и error taxonomy.
- Protocol diagnostics только через stderr (уже соблюдается).
- MCP Inspector smoke tests и compatibility tests с реальными клиентами.
- Конфигурационные пресеты для Claude Code, Cursor, Cline и Continue.
- Опциональный remote transport — только после подтверждения спроса.

## Критерии готовности

- успешная интеграция минимум с тремя реальными MCP clients;
- malformed requests не приводят к повреждению протокола;
- stdout/stdin transport остаётся чистым;
- опубликована матрица поддерживаемых clients и protocol versions.

---

# v0.8 — Enterprise controls (planned)

**Частично закрыто в v0.4–v0.5:** secret filtering, symlink policy,
path traversal rejection, `verify` command, SECURITY.md, deterministic output.

**Цель:** подготовить продукт к организациям с требованиями к контролю и воспроизводимости.

## Возможности

- Read-only mode как явный, документированный контракт.
- Настраиваемая sensitive-file policy и organization-owned ignore rules.
- Drift detection в CI как готовый workflow.
- Context schema versioning и migration tooling.
- Threat model и audit guidance.

## Критерии готовности

- доступ к файлам за пределами repository root отсутствует (покрыто тестами);
- контекст можно безопасно генерировать в CI;
- изменение schema обнаруживается явной ошибкой или миграцией;
- security-sensitive scenarios покрыты отдельными тестами.

---

# v1.0 — Stable repository intelligence

**Цель:** стабильная версия с проверенным API, зрелыми integrations и измеримой ценностью для команд.

## Обязательные компоненты

- Стабильные semver API для `core`, `cli` и `mcp`.
- Стабильная context schema и migration policy.
- Task-oriented context и impact analysis поверх корректного графа.
- Качественный TypeScript/JavaScript structural analysis.
- Temporal context для Git history.
- Поддержка npm workspaces и проверенных monorepo-сценариев.
- Production-ready local CLI и stdio MCP server.
- Compatibility matrix для Node.js и MCP clients.
- Benchmark report на публичных репозиториях.

## Критерии выпуска

- zero known critical/high vulnerabilities in supported dependency graph;
- verify, typecheck и integration tests проходят на поддерживаемых версиях Node.js;
- нет known data-loss или path traversal defects;
- API changes проходят deprecation policy;
- release process воспроизводим (`node tools/set-version.mjs`);
- минимум три реальных пользователя/команды подтверждают регулярное использование в agent workflow.

## Не гарантируется в 1.0

- полноценный compiler-grade analyzer для всех языков;
- универсальная замена tree-sitter, Sourcegraph или встроенному repository indexing;
- автоматическое понимание бизнес-логики без evidence;
- отправка исходного кода во внешние сервисы.

---

# После 1.0

Приоритетные направления определяются данными использования:

- semantic search и embeddings как optional backend;
- дополнительные языки через pluggable adapters;
- call graph и impact analysis для enterprise use cases;
- VS Code extension и Git hooks;
- GitHub Actions и GitLab CI integrations;
- team/shared context registry;
- web dashboard для context health и architecture drift;
- remote MCP deployment;
- import/export из других code graph formats;
- платные Pro/Team/Enterprise возможности.

## Метрики roadmap

Метрики разделены на **измеримые автоматически** и **требующие внешних данных**.
Агент не отправляет телеметрию, поэтому продуктовые метрики собираются только
через opt-in опросы и issue activity — это указано явно, чтобы в отчётности не
появилось цифр, которых никто не измерял.

### Измеримо автоматически (CI)

- import resolution rate (resolved / total internal imports);
- density графа зависимостей на реальных репозиториях;
- entry-point и dependency precision/recall на размеченном наборе;
- evidence coverage: доля выводов с хотя бы одним evidence;
- determinism: побайтовое совпадение контекста для одного commit;
- incremental correctness и parsed/reused ratio;
- full scan / incremental scan duration по размеру репозитория;
- token budget: байты `explain <module>` против байт всех файлов модуля.

### Требуют внешних данных (opt-in, без телеметрии)

- reduction in tokens consumed by coding agents;
- reduction in time-to-first-correct-change;
- fewer incorrect file/module selections;
- repeat usage after 7 and 30 days;
- weekly active users, active MCP installations;
- support/issue volume per release.

## Release checklist для каждой версии

- [ ] Обновлены README и migration notes.
- [ ] Обновлены API/CLI/MCP schemas.
- [ ] Добавлены unit и integration tests для нового поведения.
- [ ] Каждый новый анализатор покрыт тестом, падающим до исправления.
- [ ] Проверены Windows, Linux и macOS (CI matrix).
- [ ] Выполнены `npm run verify`, `npm audit` и `git diff --check`.
- [ ] Проверены performance и deterministic output.
- [ ] Версия выставлена через `node tools/set-version.mjs <semver>`.
- [ ] Проверена публикация всех затронутых npm packages через dry run.
- [ ] Обновлены known limitations и security notes.
- [ ] Подготовлены release notes с измеримыми изменениями.