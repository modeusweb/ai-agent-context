/**
 * Heuristic architectural role detection.
 *
 * Every role is a {@link Detection}: a value, a confidence and the evidence that
 * produced it. Nothing here claims to be a fact — `payments` is reported as
 * "looks like a service layer (0.72)" together with the signals behind it, so an
 * agent (or a human) can verify instead of trusting.
 *
 * Confidences combine probabilistically (`1 - Π(1 - w)`): two independent signals
 * are measurably stronger than one, and a single weak signal never looks certain.
 */
import type { Detection, ExternalDependency, FileNode, ModuleNode, ModuleRole } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import { SIGNALS } from '../../adapters/language/types.ts';
import { clampConfidence, compareStrings, uniqueSorted } from '../../model/canonical.ts';
import { truncate } from '../../util/text.ts';

interface SignalRule {
  role: ModuleRole;
  signals: string[];
  weight: number;
  label: string;
}

/** Signals emitted by language adapters → architectural roles. */
const SIGNAL_RULES: SignalRule[] = [
  { role: 'repository', signals: [SIGNALS.dbAccess], weight: 0.62, label: 'contains database access' },
  { role: 'adapter', signals: [SIGNALS.externalSdk], weight: 0.55, label: 'integrates with an external SDK' },
  { role: 'adapter', signals: [SIGNALS.httpClient], weight: 0.5, label: 'performs HTTP calls to other services' },
  { role: 'controller', signals: [SIGNALS.httpRoute], weight: 0.6, label: 'registers HTTP route handlers' },
  {
    role: 'controller',
    signals: [SIGNALS.httpFramework],
    weight: 0.45,
    label: 'imports an HTTP framework or binds a network listener',
  },
  { role: 'api-routes', signals: [SIGNALS.graphql], weight: 0.55, label: 'uses a GraphQL server library' },
  { role: 'eventing', signals: [SIGNALS.queue], weight: 0.55, label: 'publishes or consumes queued messages' },
  { role: 'eventing', signals: [SIGNALS.eventEmitter], weight: 0.45, label: 'emits or subscribes to events' },
  { role: 'worker', signals: [SIGNALS.worker], weight: 0.55, label: 'uses worker threads' },
  { role: 'worker', signals: [SIGNALS.schedule], weight: 0.45, label: 'schedules recurring work' },
  { role: 'ui', signals: [SIGNALS.uiFramework], weight: 0.55, label: 'imports a UI framework' },
  { role: 'ui', signals: [SIGNALS.jsx], weight: 0.4, label: 'contains JSX' },
  { role: 'ui', signals: [SIGNALS.browserApi], weight: 0.35, label: 'uses browser APIs' },
  { role: 'cli', signals: [SIGNALS.cliFramework], weight: 0.6, label: 'uses a CLI argument parsing library' },
  {
    role: 'configuration',
    signals: [SIGNALS.configLibrary],
    weight: 0.5,
    label: 'loads configuration through a config library',
  },
  { role: 'configuration', signals: [SIGNALS.envAccess], weight: 0.35, label: 'reads environment variables' },
  { role: 'infrastructure', signals: [SIGNALS.loggingLibrary], weight: 0.45, label: 'configures logging' },
  { role: 'domain', signals: [SIGNALS.customErrorClass], weight: 0.35, label: 'declares domain specific error classes' },
  { role: 'test-support', signals: [SIGNALS.testFramework], weight: 0.5, label: 'imports a test framework' },
  { role: 'shared', signals: [SIGNALS.validation], weight: 0.35, label: 'declares validation schemas' },
];

interface NameRule {
  role: ModuleRole;
  pattern: RegExp;
  weight: number;
  label: string;
}

/** Directory / file naming signals → architectural roles. */
const NAME_RULES: NameRule[] = [
  {
    role: 'repository',
    pattern: /(^|[/_.-])(repository|repositories|dao)([/_.-]|$)/i,
    weight: 0.5,
    label: 'name matches *Repository*',
  },
  {
    role: 'adapter',
    pattern: /(^|[/_.-])(adapters?|clients?|gateways?|providers?|integrations?)([/_.-]|$)/i,
    weight: 0.5,
    label: 'name matches *Adapter* / *Client* / *Provider*',
  },
  { role: 'controller', pattern: /(^|[/_.-])(controllers?|handlers?)([/_.-]|$)/i, weight: 0.5, label: 'name matches *Controller*' },
  {
    role: 'api-routes',
    pattern: /(^|[/_.-])(routes?|api|endpoints?|resolvers?)([/_.-]|$)/i,
    weight: 0.45,
    label: 'name matches *route* / *api*',
  },
  {
    role: 'service',
    pattern: /(^|[/_.-])(services?|usecases?|use-cases?|application)([/_.-]|$)/i,
    weight: 0.45,
    label: 'name matches *Service*',
  },
  {
    role: 'domain',
    pattern: /(^|[/_.-])(domain|entities|entity|models?)([/_.-]|$)/i,
    weight: 0.4,
    label: 'name matches *domain* / *entity* / *model*',
  },
  {
    role: 'infrastructure',
    pattern: /(^|[/_.-])(infra|infrastructure|db|database|persistence|migrations?|storage)([/_.-]|$)/i,
    weight: 0.45,
    label: 'name matches infrastructure vocabulary',
  },
  {
    role: 'eventing',
    pattern: /(^|[/_.-])(events?|messaging|pubsub|broker)([/_.-]|$)/i,
    weight: 0.45,
    label: 'name matches *event* / *messaging*',
  },
  {
    role: 'worker',
    pattern: /(^|[/_.-])(jobs?|workers?|queues?|schedulers?)([/_.-]|$)/i,
    weight: 0.45,
    label: 'name matches *job* / *worker* / *queue*',
  },
  {
    role: 'ui',
    pattern: /(^|[/_.-])(components?|ui|views|pages|screens|widgets?)([/_.-]|$)/i,
    weight: 0.4,
    label: 'name matches UI vocabulary',
  },
  { role: 'cli', pattern: /(^|[/_.-])(cli|commands?|bin)([/_.-]|$)/i, weight: 0.5, label: 'name matches *cli* / *command*' },
  {
    role: 'configuration',
    pattern: /(^|[/_.-])(config|configuration|settings|env)([/_.-]|$)/i,
    weight: 0.4,
    label: 'name matches *config*',
  },
  {
    role: 'shared',
    pattern: /(^|[/_.-])(utils?|helpers?|shared|common|lib|types)([/_.-]|$)/i,
    weight: 0.35,
    label: 'name matches *utils* / *shared*',
  },
  {
    role: 'test-support',
    pattern: /(^|[/_.-])(tests?|specs?|testing|fixtures|mocks)([/_.-]|$)/i,
    weight: 0.5,
    label: 'name matches test vocabulary',
  },
];

export interface RoleDetectionInput {
  module: ModuleNode;
  files: FileNode[];
  parsed: Map<string, ParsedFile>;
  externalDependencies: ExternalDependency[];
}

interface Candidate {
  role: ModuleRole;
  weights: number[];
  evidence: Array<{ source: string; detail: string }>;
}

function probabilistic(weights: readonly number[]): number {
  if (weights.length === 0) return 0;
  const inverse = weights.reduce((accumulator, weight) => accumulator * (1 - Math.min(0.75, weight)), 1);
  return clampConfidence(1 - inverse);
}

/** Detects architectural roles of a module, with confidence and evidence. */
export function detectModuleRoles(input: RoleDetectionInput): Detection<ModuleRole>[] {
  const { module } = input;
  const candidates = new Map<ModuleRole, Candidate>();
  const moduleFiles = input.files.filter((file) => module.files.includes(file.path));

  const add = (role: ModuleRole, weight: number, evidence: { source: string; detail: string }): void => {
    const candidate = candidates.get(role) ?? { role, weights: [], evidence: [] };
    candidate.weights.push(weight);
    if (candidate.evidence.length < 5) candidate.evidence.push(evidence);
    candidates.set(role, candidate);
  };

  const moduleSignals = new Set(module.signals);
  for (const rule of SIGNAL_RULES) {
    for (const signal of rule.signals) {
      if (!moduleSignals.has(signal)) continue;
      const example = moduleFiles.find((file) => file.signals.includes(signal));
      add(rule.role, rule.weight, {
        source: example?.path ?? module.path,
        detail: `${rule.label} (signal: ${signal})`,
      });
    }
  }

  const nameCorpus = [module.id, module.path, module.name].filter((entry) => entry.length > 0).join('/');
  for (const rule of NAME_RULES) {
    const match = rule.pattern.exec(nameCorpus);
    if (match !== null) {
      add(rule.role, rule.weight, { source: module.path || module.id, detail: `${rule.label} ("${match[0]}")` });
    }
  }

  if (module.isWorkspacePackage) {
    add('workspace-package', 0.99, { source: 'package.json', detail: 'module is a workspace package' });
  }

  const externalNames = new Set(input.externalDependencies.map((entry) => entry.name));
  const applicationEntry = module.entryPoints.find((entry) => entry.type === 'application');
  if (applicationEntry !== undefined) {
    add('application', 0.6, { source: applicationEntry.path, detail: 'module exposes an application entry point' });
  }
  const cliEntry = module.entryPoints.find((entry) => entry.type === 'cli' || entry.type === 'package-bin');
  if (cliEntry !== undefined) {
    add('cli', 0.62, { source: cliEntry.path, detail: 'module exposes a command line entry point' });
  }
  if ([...externalNames].some((name) => name === '@nestjs/core' || name === 'express' || name === 'fastify')) {
    add('controller', 0.4, { source: 'package.json', detail: 'declares an HTTP framework dependency' });
  }
  if (module.files.length === 0) {
    add('configuration', 0.2, { source: module.path, detail: 'module contains no analyzed source files' });
  }

  return [...candidates.values()]
    .map((candidate) => ({
      value: candidate.role,
      confidence: candidate.role === 'workspace-package' ? 0.99 : probabilistic(candidate.weights),
      evidence: candidate.evidence,
    }))
    .filter((detection) => detection.confidence >= 0.3)
    .sort((a, b) => (a.confidence === b.confidence ? compareStrings(a.value, b.value) : b.confidence - a.confidence))
    .slice(0, 4);
}

/**
 * Responsibilities of a module.
 *
 * Assembled from verifiable material only: detected roles (explicitly labelled
 * `heuristic`), the public API surface, signals observed in the files and
 * documentation committed inside the module.
 */
export function detectResponsibilities(module: ModuleNode, parsed: Map<string, ParsedFile>): Detection[] {
  const responsibilities: Detection[] = [];
  for (const role of module.roles) {
    responsibilities.push({
      value: `role: ${role.value} (heuristic)`,
      confidence: role.confidence,
      evidence: role.evidence,
    });
  }

  const publicNames = module.publicExports.slice(0, 8).map((entry) => entry.name);
  if (publicNames.length > 0) {
    responsibilities.push({
      value: `public API: ${publicNames.join(', ')}`,
      confidence: 0.9,
      evidence: module.publicExports.slice(0, 3).map((entry) => ({
        source: entry.file,
        detail: `exports ${entry.name} (${entry.kind})`,
      })),
    });
  }

  const documentation = module.files.filter((path) => path.toLowerCase().endsWith('.md')).sort(compareStrings);
  for (const file of documentation) {
    const paragraph = parsed.get(file)?.metadata['markdown.firstParagraph'];
    if (typeof paragraph !== 'string' || paragraph.trim().length === 0) continue;
    responsibilities.push({
      value: `documented: ${truncate(paragraph, 220)}`,
      confidence: 0.8,
      evidence: [{ source: file, detail: 'module documentation' }],
    });
    break;
  }

  const signalStatements: Array<{ signal: string; statement: string }> = [
    { signal: SIGNALS.dbAccess, statement: 'accesses the database' },
    { signal: SIGNALS.httpRoute, statement: 'exposes HTTP routes' },
    { signal: SIGNALS.externalSdk, statement: 'talks to an external service SDK' },
    { signal: SIGNALS.queue, statement: 'interacts with a message queue' },
    { signal: SIGNALS.worker, statement: 'runs background work' },
  ];
  for (const entry of signalStatements) {
    if (!module.signals.includes(entry.signal)) continue;
    responsibilities.push({
      value: `observed: ${entry.statement}`,
      confidence: 0.75,
      evidence: [{ source: module.files[0] ?? module.path, detail: `signal ${entry.signal}` }],
    });
  }

  return responsibilities.slice(0, 8);
}

/** Sorted, unique list of detected role values (used by `diff`). */
export function roleValues(roles: readonly Detection<ModuleRole>[]): string[] {
  return uniqueSorted(roles.map((role) => role.value));
}