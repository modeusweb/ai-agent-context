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

Текущая версия пакетов: `0.3.7`.

Уже реализованы:

- ядро анализатора без runtime-зависимостей;
- CLI: `init`, `scan`, `status`, `explain`, `search`, `diff`, `clean`;
- MCP stdio-сервер с инструментами для repository context;
- incremental scanning и content-addressed parse cache;
- knowledge graph и определение модулей;
- определение entry points, dependencies, conventions и decisions;
- Git activity signals;
- детерминированная сериализация в `.agent/`;
- secret filtering и local-only режим;
- workspace-поддержка npm-пакетов;
- 81 tests, build и typecheck в текущем verify pipeline;
- task-oriented context, change impact и bounded repository projections;
- local benchmark harness и `benchmark-report.json` для пяти fixture-репозиториев.

## Приоритеты

- **P0** — доказать измеримую пользу и стабилизировать основной workflow.
- **P1** — сделать контекст релевантным задаче и повысить качество анализа.
- **P2** — добавить temporal context, зрелый MCP и enterprise controls.
- **P3** — развивать экосистему и интеграции после подтверждённого спроса.

---

# v0.3 — Agent-ready context (completed)

**Цель:** превратить полный repository context в компактный контекст, который AI agent может эффективно использовать для конкретной задачи.

**Реализовано в текущем срезе:**

- `getTaskContext(task, options)` с bounded `maxModules` и optional `target`;
- `getChangeImpact(target, options)` с bounded `maxFiles`;
- CLI-команды `task` и `impact`;
- MCP tools `get_context_for_task` и `get_change_impact`;
- evidence для выбранных модулей и impact-срезов;
- regression coverage в CLI/MCP integration tests.

**Статус:** функциональный срез завершён; релиз `0.3.1` отправлен в npm, публикация ожидает завершения обработки registry.

**Проверено:** compact projections, task context, change impact, benchmark harness, migration notes.

## Возможности

- `get_context_for_task` — контекст по описанию задачи и целевому пути.
- `get_change_impact` — потенциально затронутые модули, зависимости, тесты и conventions.
- `get_module_context` — ограниченный контекст одного модуля.
- Compact context mode с лимитом размера и количества элементов.
- Budget-aware ranking результатов.
- Evidence и confidence для каждого значимого вывода.
- Явное разделение `observed`, `inferred` и `configured` facts.
- CLI-команды для task context и impact analysis.
- JSON output с версионированной схемой.

## Качество и совместимость

- Не менять формат `.agent/` без major schema migration.
- Сохранять deterministic output при одинаковом входном состоянии.
- Не добавлять обязательные runtime-зависимости в `@ai-agent-context/core`.
- Добавить contract tests для всех новых API и MCP tools.
- Добавить benchmark на 10+ реальных репозиториях.
- Проверить сценарии на монорепозиториях и legacy-проектах.

## Критерии готовности

- агент получает релевантный контекст без ручного чтения большого числа файлов;
- пользователь может задать лимит контекста;
- каждый новый вывод объясним через evidence;
- benchmark подтверждает снижение объёма контекста и/или времени выполнения задачи;
- все текущие сценарии `init → scan → explain → diff` остаются рабочими.

---

# v0.4 — Structural intelligence (in progress)

**Текущий срез:** добавлены explainable layering diagnostics с confidence и evidence; расширенные import/export/route/call/cycle capabilities уже присутствуют в графе и проходят regression coverage. Добавлены bounded `getModuleHistory` и `getRevisionDiff`; snapshot/context-at-revision и decision linkage остаются следующим подэтапом v0.5.
**Цель:** повысить точность структурного анализа TypeScript/JavaScript и добавить ограниченный impact analysis.

## Возможности

- Расширенный extraction для dynamic imports, re-exports, namespaces, aliases и conditional exports.
- Точное определение barrel files и публичного API.
- Связи `test → module` и `entry point → module`.
- Call graph для поддерживаемых сценариев.
- Framework-aware extraction для популярных HTTP routes.
- Диагностика import cycles.
- Проверка layering violations.
- Опциональный tree-sitter/compiler backend без потери lightweight default mode.
- Расширенный architecture diff с объяснением причин.
- Layering violations с confidence и evidence для вероятных нарушений направления зависимостей.

## Качество и совместимость

- Описать supported constructs и известные ограничения.
- Покрыть edge cases в fixtures и regression tests.
- Не принимать optional backend как обязательную зависимость базовой установки.
- Измерить precision/recall для entry points, modules и dependencies.
- Сохранить graceful degradation при отсутствии Git или optional backend.

## Критерии готовности

- на benchmark-наборе entry-point accuracy не ниже согласованного baseline;
- dependency precision и recall измеримы и опубликованы;
- false positives на динамических импортах и barrel files не регрессируют;
- impact analysis возвращает проверяемые evidence paths;
- версия проходит полный verify pipeline.

---

# v0.5 — Temporal context (in progress)

**Текущий срез:** добавлены bounded `getModuleHistory` и `getRevisionDiff`, `parseGitDiff` и MCP tools `get_module_history`/`get_revision_diff`; обработка invalid revision, shallow history и отсутствия Git остаётся graceful. Следующий подэтап — persisted snapshots/context-at-revision и decision linkage.

**Цель:** превратить Git history из дополнительного сигнала в полноценную функцию продукта.

## Возможности

- `module-history` — история изменений модуля.
- `architecture-history` — изменения архитектуры во времени.
- `context-at-revision` — анализ состояния на выбранном Git revision.
- `diff-from-revision` — сравнение контекста с заданной ревизией.
- Churn, hotspots и ownership signals.
- Связь commits, файлов, модулей и architectural decisions.
- `why-was-this-changed` evidence.
- Экспорт и импорт snapshots контекста.

## Качество и совместимость

- Git недоступен — операция возвращает понятный diagnostic, а не падает.
- Поддержать shallow clone и ограниченный Git history.
- Ограничить глубину и объём history traversal.
- Детерминировать порядок результатов.
- Покрыть merge commits, renames, deletes и root commits.

## Критерии готовности

- пользователь может объяснить, как менялся модуль и почему;
- snapshot на одном revision воспроизводим;
- history не блокирует обычный scan на больших репозиториях;
- все history-команды имеют JSON output и documented exit codes.

---

# v0.6 — MCP production readiness (in progress)

**Текущий срез:** реализованы Resources/Prompts, read-only stdio transport и строгая pre-dispatch валидация tool arguments по JSON Schema subset. Остаются cancellation/timeouts и фактическая compatibility matrix с внешними clients.

**Цель:** сделать MCP-пакет надёжным и удобным для реальных клиентов.

## Возможности

- Поддержка актуального MCP protocol и совместимых clients.
- Resources для архитектуры, dependencies, conventions, decisions и modules.
- Prompts для onboarding, code review, refactoring planning и change preparation.
- Полноценная валидация inputs и outputs по JSON Schema.
- Request cancellation, timeouts и error taxonomy.
- Protocol diagnostics только через stderr.
- MCP Inspector smoke tests и compatibility tests.
- Конфигурационные пресеты для Claude Code, Cursor, Cline и Continue.
- Опциональный remote transport — только после подтверждения спроса.

## Критерии готовности

- успешная интеграция минимум с тремя реальными MCP clients;
- malformed requests не приводят к повреждению протокола;
- stdout/stdin transport остаётся чистым;
- tools/resources/prompts имеют стабильные схемы;
- опубликована матрица поддерживаемых clients и protocol versions.

---

# v0.7 — Enterprise controls

**Цель:** подготовить продукт к организациям с требованиями к безопасности, контролю и воспроизводимости.

## Возможности

- Read-only mode и запрет изменения repository files.
- Строгая path traversal и symlink protection.
- Настраиваемая sensitive-file policy.
- Версионирование и migration context schema.
- Context verification и schema validation commands.
- Drift detection в CI.
- Reproducible context output для одинакового commit.
- Security policy, threat model и audit guidance.
- Конфигурация для organization-owned ignore rules.
- Документированный offline mode.

## Критерии готовности

- доступ к файлам за пределами repository root отсутствует;
- контекст можно безопасно генерировать в CI;
- изменение schema обнаруживается явной ошибкой или миграцией;
- пользователь может проверить, почему context считается stale;
- security-sensitive scenarios покрыты отдельными тестами.

---

# v1.0 — Stable repository intelligence

**Цель:** стабильная версия с проверенным API, зрелыми integrations и измеримой ценностью для команд.

## Обязательные компоненты

- Стабильные semver API для `core`, `cli` и `mcp`.
- Стабильная context schema и migration policy.
- Task-oriented context и impact analysis.
- Качественный TypeScript/JavaScript structural analysis.
- Temporal context для Git history.
- Поддержка npm workspaces и проверенных monorepo-сценариев.
- Production-ready local CLI.
- Production-ready stdio MCP server.
- Compatibility matrix для Node.js и MCP clients.
- Benchmark report на публичных и внутренних наборах репозиториев.

## Критерии выпуска

- zero known critical/high vulnerabilities in supported dependency graph;
- verify, typecheck и integration tests проходят на поддерживаемых версиях Node.js;
- нет known data-loss или path traversal defects;
- API changes проходят deprecation policy;
- release process воспроизводим;
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

### Product value

- reduction in tokens consumed by coding agents;
- reduction in time-to-first-correct-change;
- fewer incorrect file/module selections;
- repeat usage after 7 and 30 days;
- number of repositories using `.agent/` context.

### Analysis quality

- entry-point precision and recall;
- dependency graph precision and recall;
- architecture-diff correctness;
- evidence coverage;
- stale-context false-positive rate;
- incremental scan correctness.

### Performance

- full scan duration by repository size;
- incremental scan duration;
- parsed/reused file ratio;
- memory usage;
- MCP response latency.

### Adoption and quality

- weekly active users;
- active MCP installations;
- pilot-to-weekly-active conversion;
- time to first successful agent task;
- support/issue volume per release.

## Release checklist для каждой версии

- [ ] Обновлены README и migration notes.
- [ ] Обновлены API/CLI/MCP schemas.
- [ ] Добавлены unit и integration tests для нового поведения.
- [ ] Проверены Windows, Linux и macOS для поддерживаемых сценариев.
- [ ] Выполнены `npm run verify`, `npm audit` и `git diff --check`.
- [ ] Проверены performance и deterministic output.
- [ ] Проверена публикация всех затронутых npm packages через dry run.
- [ ] Обновлены known limitations и security notes.
- [ ] Подготовлены release notes с измеримыми изменениями.

