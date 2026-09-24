/**
 * Tool handlers.
 *
 * Thin adapters over the core API: they resolve the repository root, obtain an
 * AgentContext (cached per root so repeated tool calls do not rescan) and return
 * plain JSON payloads. No analysis, no caching policy, no formatting logic lives
 * here.
 */
import { AgentContext, type AgentContextOptions } from '@ai-agent-context/core';

export interface ToolHandlerDependencies {
  /** Default repository root (from the CLI flag or the environment). */
  root: string;
  /** Injectable factory, used by tests. */
  createContext?: (options: AgentContextOptions) => Promise<AgentContext>;
}

export interface ToolCallResult {
  /** `true` when the tool could not satisfy the request. */
  isError: boolean;
  payload: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string');
  return items.length > 0 ? items : undefined;
}

/** Per-root context cache: an MCP session should not rescan on every call. */
export class ContextPool {
  private readonly contexts = new Map<string, Promise<AgentContext>>();
  private readonly dependencies: ToolHandlerDependencies;

  constructor(dependencies: ToolHandlerDependencies) {
    this.dependencies = dependencies;
  }

  async get(root: string): Promise<AgentContext> {
    const existing = this.contexts.get(root);
    if (existing !== undefined) return existing;
    const options: AgentContextOptions = { root };
    const pending =
      this.dependencies.createContext === undefined
        ? AgentContext.load(options)
        : this.dependencies.createContext(options);
    this.contexts.set(root, pending);
    return pending;
  }

  clear(): void {
    this.contexts.clear();
  }
}

function errorPayload(message: string, extra: Record<string, unknown> = {}): ToolCallResult {
  return { isError: true, payload: { error: message, ...extra } };
}

/** Executes an MCP tool by name (first half of the switch). */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  pool: ContextPool,
  defaultRoot: string,
): Promise<ToolCallResult> {
  const root = asString(args['root']) ?? defaultRoot;

  switch (name) {
    case 'get_context_for_task': {
      const task = asString(args['task']);
      if (task === undefined) return errorPayload('get_context_for_task requires the "task" argument');
      const target = asString(args['target']);
      const maxModules = asNumber(args['maxModules']);
      const context = await pool.get(root);
      return {
        isError: false,
        payload: await context.getTaskContext(task, {
          ...(target === undefined ? {} : { target }),
          ...(maxModules === undefined ? {} : { maxModules }),
        }),
      };
    }

    case 'get_change_impact': {
      const target = asString(args['target']);
      if (target === undefined) return errorPayload('get_change_impact requires the "target" argument');
      const maxFiles = asNumber(args['maxFiles']);
      const context = await pool.get(root);
      try {
        return { isError: false, payload: await context.getChangeImpact(target, maxFiles === undefined ? {} : { maxFiles }) };
      } catch (error) {
        return errorPayload(error instanceof Error ? error.message : String(error));
      }
    }

    case 'get_repository_context': {
      const context = await pool.get(root);
      const options = {
        ...(asNumber(args['maxModules']) === undefined ? {} : { maxModules: asNumber(args['maxModules']) }),
        ...(asNumber(args['maxEntryPoints']) === undefined ? {} : { maxEntryPoints: asNumber(args['maxEntryPoints']) }),
        ...(asNumber(args['maxExternalDependencies']) === undefined ? {} : { maxExternalDependencies: asNumber(args['maxExternalDependencies']) }),
        ...(asNumber(args['maxConventions']) === undefined ? {} : { maxConventions: asNumber(args['maxConventions']) }),
        ...(asNumber(args['maxDecisions']) === undefined ? {} : { maxDecisions: asNumber(args['maxDecisions']) }),
        ...(asNumber(args['maxCycles']) === undefined ? {} : { maxCycles: asNumber(args['maxCycles']) }),
      };
      return { isError: false, payload: await context.getRepositoryContext(options) };
    }

    case 'explain_module': {
      const target = asString(args['path']) ?? asString(args['module']);
      if (target === undefined) return errorPayload('explain_module requires the "path" argument');
      const context = await pool.get(root);
      const explanation = await context.explain(target);
      if (explanation === null) {
        return errorPayload(`no module or file matched "${target}"`, {
          hint: 'Call get_repository_context to list module ids, or search_context to find the module.',
        });
      }
      return { isError: false, payload: explanation };
    }

    case 'get_dependencies': {
      const context = await pool.get(root);
      const module = asString(args['module']);
      if (module === undefined) return { isError: false, payload: await context.getDependencies() };
      const explanation = await context.explain(module);
      if (explanation === null) return errorPayload(`no module matched "${module}"`);
      const document = await context.getDependencies();
      return {
        isError: false,
        payload: {
          module: explanation.module.id,
          dependsOn: explanation.dependsOn,
          usedBy: explanation.usedBy,
          externalDependencies: explanation.externalDependencies,
          fileImports: document.fileImports.filter((entry) => entry.module === explanation.module.id),
        },
      };
    }

    case 'get_dependents': {
      const module = asString(args['module']);
      if (module === undefined) return errorPayload('get_dependents requires the "module" argument');
      const context = await pool.get(root);
      const explanation = await context.explain(module);
      if (explanation === null) return errorPayload(`no module matched "${module}"`);
      const repository = await context.getRepository();
      const filesByModule = new Map(repository.modules.map((entry) => [entry.id, entry.files]));
      return {
        isError: false,
        payload: {
          module: explanation.module.id,
          direct: explanation.usedBy,
          transitive: explanation.impact.modules,
          files: explanation.impact.files.slice(0, 200),
          moduleFiles: Object.fromEntries(
            explanation.impact.modules
              .slice(0, 50)
              .map((id) => [id, filesByModule.get(id) ?? []] as [string, string[]]),
          ),
        },
      };
    }

    case 'search_context': {
      const query = asString(args['query']);
      if (query === undefined) return errorPayload('search_context requires the "query" argument');
      const limit = asNumber(args['limit']) ?? 10;
      const types = asStringArray(args['types']);
      const context = await pool.get(root);
      const searchOptions: { limit: number; types?: Array<'file' | 'module' | 'symbol' | 'decision' | 'convention' | 'entry-point' | 'dependency'> } = { limit };
      if (types !== undefined) searchOptions.types = types as typeof searchOptions.types;
      const results = await context.search(query, searchOptions);
      return { isError: false, payload: { query, backend: 'bm25', results } };
    }

    case 'get_module_history': {
      const target = asString(args['target']);
      if (target === undefined) return errorPayload('get_module_history requires the "target" argument');
      const limit = asNumber(args['limit']);
      try {
        return { isError: false, payload: await (await pool.get(root)).getModuleHistory(target, limit === undefined ? {} : { limit }) };
      } catch (error) {
        return errorPayload(error instanceof Error ? error.message : String(error));
      }
    }

    case 'get_revision_diff': {
      const revision = asString(args['revision']);
      if (revision === undefined) return errorPayload('get_revision_diff requires the "revision" argument');
      const base = asString(args['base']);
      return { isError: false, payload: await (await pool.get(root)).getRevisionDiff(revision, base ?? 'HEAD') };
    }

    case 'get_architecture': {
      const context = await pool.get(root);
      const architecture = await context.getArchitecture();
      const module = asString(args['module']);
      if (module === undefined) return { isError: false, payload: architecture };
      const explanation = await context.explain(module);
      if (explanation === null) return errorPayload(`no module matched "${module}"`);
      const entry = architecture.modules.find((candidate) => candidate.id === explanation.module.id) ?? null;
      return {
        isError: false,
        payload: { summary: architecture.summary, workspace: architecture.workspace, module: entry },
      };
    }

    case 'get_conventions': {
      const context = await pool.get(root);
      const conventions = await context.getConventions();
      const category = asString(args['category']);
      const filtered =
        category === undefined
          ? conventions
          : conventions.filter((convention) => convention.category.toLowerCase() === category.toLowerCase());
      return {
        isError: false,
        payload: {
          total: conventions.length,
          category: category ?? null,
          conventions: filtered,
          note: 'Every statement is a counted observation; confidence and evidence are attached.',
        },
      };
    }

    case 'get_decisions': {
      const context = await pool.get(root);
      const decisions = await context.getDecisions();
      const origin = asString(args['origin']);
      const filtered = origin === undefined ? decisions : decisions.filter((decision) => decision.origin === origin);
      return {
        isError: false,
        payload: {
          total: decisions.length,
          origin: origin ?? null,
          explicit: filtered.filter((decision) => decision.origin === 'explicit').length,
          decisions: filtered,
          note: 'Entries with origin "inferred" were derived heuristically and carry their evidence.',
        },
      };
    }

    default:
      return errorPayload(`unknown tool "${name}"`, { available: 'see tools/list' });
  }
}