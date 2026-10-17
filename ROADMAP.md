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

Текущая версия пакетов: `0.9.0`.

Уже реализованы:

- ядро анализатора без runtime-зависимостей;
- CLI: `init`, `scan`, `status`, `explain`, `context`, `task`, `impact`, `search`, `diff`, `detect`, `history`, `revision-diff`, `verify`, `clean`;
- MCP stdio-сервер: 14 tools, Resources, Prompts, строгая валидация аргументов;
- dual-era MCP: пять ревизий протокола, negotiation, `server/discover`, cancellation,
  timeouts, error taxonomy и пресеты конфигурации для четырёх клиентов;
- incremental scanning и content-addressed parse cache;
- knowledge graph, определение модулей, entry points, cycles, layering diagnostics;
- определение dependencies, conventions и decisions с confidence и evidence;
- temporal context: `getModuleHistory`, `getRevisionDiff`, `getRevisionSnapshot`;
- directory-scoped `explain`/`impact` вместо молчаливого расширения до родительского модуля;
- budget-aware `explain`: проекция `compact`/`full` выбирается по размеру модуля;
- path traversal отклоняется, а не схлопывается, и всегда попадает в отчёт;
- Git activity signals, детерминированная сериализация в `.agent/`, secret filtering;
- workspace-поддержка npm workspaces;
- `agent-context detect` и MCP tool `detect_coverage_gaps`: что именно анализатор
  не смог определить;
- benchmark, который измеряет import resolution rate и token budget по бакетам размера;
- organization-owned policy (`.agent-policy.json`), которая может только ужесточать настройки репозитория;
- read-only контракт: `security.readOnly` и `--read-only`, проверка в фасаде `AgentContext`;
- `agent-context migrate` и переиспользуемый CI workflow для drift-детекции.

Не закрыто и требует внешних данных: подтверждение интеграции с тремя реальными
MCP-клиентами и opt-in опрос реальных пользователей.

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

# v0.6 — Measurable value (completed)

**Цель:** заменить лозунг «компактный контекст» измеренными цифрами, которые
можно воспроизвести.

Причина задержки: пока половина графа зависимостей была пустой, любое
сравнение объёма контекста сравнивало бы шум с шумом.

**Реализовано:**

- `tools/benchmark.mjs` переписан: вместо таймингов он измеряет import
  resolution rate (с классификацией unresolved: `excludedOutput` / `actionable` /
  `pathEscapes`), cold vs warm scan с parsed/reused, и token budget по бакетам
  размера модуля;
- budget-aware `explain`: проекция `compact`/`full` по размеру модуля, плюс
  явный `detail` в CLI и MCP;
- дедупликация payload: `responsibilities` больше не повторяет `roles`,
  evidence ограничен двумя записями на факт;
- `agent-context detect` и MCP `detect_coverage_gaps` — что анализатор не
  определил, с ранжированием по severity;
- исправлен баг безопасности: отклонённый path traversal исчезал из
  `dependencies.json` из-за классификации неразрешённых импортов по всему
  спецификатору, а не по последнему сегменту пути;
- собственный репозиторий добавлен в набор бенчмарка, потому что fixtures
  меньше 4 КБ и не могут проверить продуктовое утверждение.

**Измеримые результаты:**

| Метрика | Значение |
| --- | --- |
| Import resolution rate (resolvable) | 100% |
| Actionable unresolved | 0 |
| Path escapes | 0 |
| Модули >64 KB: `explain` против исходников | 0.042x (−95.8%) |
| Модули 8–64 KB | 0.343x (−65.7%) |
| Модули <8 KB, `auto` | 0.72x (было 1.84x с `full`) |
| Тестов | 150 |

**Честная оговорка, зафиксированная в бенчмарке:** на модулях меньше 4 KB
продукт остаётся дороже чтения исходников (2.07x на fixtures). Это не
прячется усреднением — бакеты существуют именно для того, чтобы этот результат
был виден.

## Критерии готовности — выполнены

- import resolution rate измерим и опубликован;
- token-budget бенчмарк показывает выигрыш против наивного чтения на больших модулях;
- incremental path exercised в бенчмарке (cold/warm с parsed/reused);
- benchmark воспроизводится одной командой, запускается в CI и публикуется как артефакт;
- пользователь может узнать, где именно анализ неполон.

## Осталось дальше

- entry-point precision/recall на размеченном наборе;
- публичный набор реальных репозиториев вместо одного собственного.

---

# v0.8 — MCP production readiness (completed, shipped as 0.8.0)

**Цель:** сделать MCP-пакет надёжным и удобным для реальных клиентов.

**Проблема, которую решил релиз.** Сервер пинил одну ревизию протокола —
`2024-11-05` — и отвечал ею на любой `initialize`. Клиент, запрашивавший
`2025-06-18`, получал инструкцию перейти на ревизию, которую сам не запрашивал,
а по спецификации обязан был после этого отключиться. Совместимость с реальными
клиентами определялась не кодом сервера, а датой его последнего обновления.

## Реализовано

- **Dual-era сервер.** Реализованы пять ревизий: legacy (`2024-11-05`,
  `2025-03-26`, `2025-06-18`, `2025-11-25`) и modern (`2026-07-28`). Эпо
  выбирается по тому, как открылся клиент: запрос с `_meta` обслуживается
  stateless, `initialize` переключает на legacy-семантику.
- **Legacy negotiation.** `initialize` отвечает запрошенной ревизией; при
  неизвестной, отсутствующей или modern отвечает newest legacy (`2025-11-25`).
- **`server/discover`** — обязательный для modern-сервера метод; сообщает
  `supportedVersions`, capabilities и идентичность сервера.
- **Modern-валидация на каждый запрос.** Неподдерживаемая ревизия отклоняется с
  `-32022` и списком для retry; отсутствие обязательного
  `io.modelcontextprotocol/clientCapabilities` — с `-32602`; modern-результаты
  несут `resultType`.
- **Cancellation.** `notifications/cancelled` гасит ответ, в том числе ответ по
  таймауту, который иначе пришёл бы следом.
- **Timeouts.** `requestTimeoutMs` (по умолчанию 120000, `0` отключает); истёкший
  запрос отвечает `-32603` с `data.timeoutMs`, поздний результат отбрасывается.
- **Error taxonomy.** Сообщение без `method` отвечает `-32600`, а не `-32601`.
  Зарезервированный `-32002` не используется.
- **Пресеты конфигурации** для Claude Code, Cursor, Cline и Continue:
  `agent-context-mcp config <client>`, плюс `--list` и `--all`.
- **Тесты реального процесса.** Сессии обеих эр, мусорный ввод, cancellation и
  timeout проверяются через настоящий stdio-процесс, а не через in-memory
  транспорт: «диагностика не попадает в stdout» иначе недоказуемо.

## Критерии готовности

- **закрыт:** malformed requests не приводят к повреждению протокола — покрыто
  тестом на мусорный ввод, который проверяет, что канал stdout остаётся
  разбираемым;
- **закрыт:** stdout/stdin transport остаётся чистым — покрыто тестом на
  реальном процессе;
- **закрыт:** опубликована матрица поддерживаемых clients и protocol versions —
  в `packages/mcp/README.md`;
- **не закрыт:** успешная интеграция минимум с тремя реальными MCP clients.
  Пресеты кодируют задокументированный формат конфигурации каждого клиента, но
  ни один из них не запускался в этой среде. Критерий остаётся открытым сознательно:
  подтвердить его может только установленный клиент.

Опциональный remote transport отложен до подтверждения спроса, как и планировалось.

---

# v0.9 — Enterprise controls (completed, shipped as 0.9.0)

**Цель:** подготовить продукт к организациям с требованиями к контролю и воспроизводимости.

**Проблема, которую решил релиз.** Репозиторий настраивается файлом, который пишут контрибьюторы. Ничто не мешало контрибьютору выставить `security.allowSensitiveFiles: true` или убрать каталог из `exclude` — и тем самым ослабить правила, которые организация считает обязательными. Набор гарантий (secret filtering, symlink policy, path traversal rejection, `verify`, детерминированный вывод) существовал, но был без принуждения: он описывал поведение инструмента, а не правило, которое нельзя обойти.

## Реализовано

- **Organization-owned policy.** `.agent-policy.json` ищется в корне репозитория и в любом родительском каталоге, так что один файл на уровне монорепозитория или организации применяется ко всему вложенному; `AGENT_CONTEXT_POLICY` переопределяет поиск. Policy — это **пол**, а не замена: паттерны объединяются с репозиторными, а не подменяют их.
- **Policy может только ужесточать.** `allowSensitiveFiles: false` принудительно выключает escape hatch, `redactSecrets: true` — принудительно включает редактирование, `readOnly: true` — принудительно включает read-only. Ни один из этих режимов репозиторий не может отменить настройкой или флагом.
- **Два документа отклоняются, а не игнорируются:** неизвестная `version` и `redactSecrets: false`. Политика, которая молча не применилась, неотличима от её отсутствия; а отключение редактирования копирует секреты в файл, который коммитят и показывают.
- **Read-only контракт.** `security.readOnly` и флаг `--read-only` запрещают любую запись и оставляют рабочими все запросы. Проверка живёт в фасаде `AgentContext`, а не в отдельных командах, поэтому её не обойти ни MCP-обработчику инструментов, ни встраиваемому сценарию, вызывающему `scan()` напрямую. Пишут только `scan()` и `init()`.
- **Изменение policy инвалидирует кэш**, поэтому контекст, построенный под более слабыми правилами, никогда не переиспользуется после их ужесточения.
- **`agent-context migrate`** приводит закоммиченный `.agent/` к текущей схеме; `--check` ничего не пишет и возвращает `1`, что делает его CI-воротами. Состояния: `current`, `stale`, `missing`, `invalid`.
- **Готовый workflow для CI:** `.github/workflows/reusable-verify-context.yml`, вызывается из другого репозитория через `uses:`.
- **Threat model расширен** на конфигурацию самого репозитория и дополнен audit guidance из пяти шагов в `SECURITY.md`.

## Критерии готовности

- **закрыт:** доступ к файлам за пределами repository root отсутствует — покрыто тестами;
- **закрыт:** контекст можно безопасно генерировать в CI — read-only режим делает невозможной запись из процесса, который только читает;
- **закрыт:** изменение schema обнаруживается явной ошибкой или миграцией — `migrate --check` плюс явный отказ читать документ неизвестной версии;
- **закрыт:** security-sensitive scenarios покрыты отдельными тестами — 27 тестов на policy и read-only, включая попытку репозитория отключить read-only и попытку отключить редактирование через policy.

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

Каждая метрика помечена статусом, чтобы список нельзя было прочитать как
отчёт о выполненной работе: **измеряется** — есть код и CI-ворота; **не
измеряется** — только заявлено.

### Измеримо автоматически (CI)

| Метрика | Статус | Где |
| --- | --- | --- |
| import resolution rate (resolved / total internal imports) | измеряется | `summary.imports.resolutionRate`, CI-ворота |
| density графа зависимостей | измеряется | `summary.graph` |
| token budget по бакетам размера модуля | измеряется | `summary.tokenBudget` |
| cold/warm scan, parsed/reused | измеряется | `row.scan` |
| evidence coverage: доля выводов с хотя бы одним evidence | измеряется с 0.10.0 | `summary.trust.coveragePercent`, CI-ворота |
| determinism: побайтовое совпадение контекста для одного commit | измеряется с 0.10.0 | `summary.trust.nonDeterministic`, CI-ворота |
| entry-point и dependency precision/recall на размеченном наборе | **не измеряется** | нужен размеченный корпус; нет и набора, и кода под него |

До 0.10.0 последние две строки были перечислены как измеримые, но в бенчмарке их
не было. Теперь они либо измерены, либо помечены как невыполненные — именно это
различие и делает раздел пригодным для чтения.

**Как считаются новые метрики.** Evidence coverage обходит сгенерированные
документы и считает объекты, несущие числовой `confidence`: это ровно те
утверждения, которые анализатор делает как эвристику. Структурные факты
(идентификаторы модулей, пути, спецификаторы импортов) `confidence` не несут и
намеренно не учитываются. Репозиторий, в котором нет ни одной эвристики,
показывает `null`, а не 100%: объяснять было нечего. Детерминизм сравнивает
побайтовый хэш документов после двух независимых сканов с отключённым кэшем,
поэтому различие может прийти только от анализатора, а не от того, что он
случайно переиспользовал.

**Текущие значения на этом репозитории и пяти фикстурах:** evidence coverage
100% (363 вывода, 0 без источника), non-deterministic репозиториев 0.

### Требуют внешних данных (opt-in, без телеметрии)

Ни одна из этих метрик не может быть получена кодом: продукт не наблюдает
себя, а агент не отправляет телеметрию.

- reduction in tokens consumed by coding agents;
- reduction in time-to-first-correct-change;
- fewer incorrect file/module selections;
- repeat usage after 7 and 30 days;
- weekly active users, active MCP installations;
- support/issue volume per release.

Отдельно: **успешная интеграция минимум с тремя реальными MCP clients** —
критерий v0.8, который остаётся открытым. Пресеты конфигурации кодируют
задокументированный формат каждого клиента, но ни один из них не был запущен в
среде разработки.

## Release checklist для каждой версии

- [ ] Обновлены README и migration notes.
- [ ] Обновлены API/CLI/MCP schemas.
- [ ] Добавлены unit и integration tests для нового поведения.
- [ ] Каждый новый анализатор покрыт тестом, падающим до исправления.
- [ ] Проверены Windows, Linux и macOS (CI matrix).
- [ ] Выполнены `npm run verify`, `npm audit` и `git diff --check`.
- [ ] Проверены performance и deterministic output.
- [ ] Собственный репозиторий пересканирован, а обновлённый `.agent/` закоммичен (`node packages/cli/dist/bin.js scan && git add .agent`). Пункт обязателен: CI job `self-scan` выполняет `init && scan` **перед** `verify`, поэтому проверяет сгенерированный контекст и не замечает протухание закоммиченного.
- [ ] Версия выставлена через `node tools/set-version.mjs <semver>`.
- [ ] Проверена публикация всех затронутых npm packages через dry run.
- [ ] Обновлены known limitations и security notes.
- [ ] Подготовлены release notes с измеримыми изменениями.