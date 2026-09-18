/**
 * Decision (ADR) detection.
 *
 * Rules of honesty enforced here:
 * - decisions found in human authored documents are `origin: "explicit"`;
 * - decisions derived from configuration or git history are `origin: "inferred"`
 *   and say so, with the evidence (file, commit sha, commit subject) attached;
 * - nothing is invented: an ADR without a status is reported as `status: unknown`.
 *
 * Sources: `docs/`, `adr/`, `architecture/`, `README.md` sections and git history.
 */
import type { Decision, DecisionStatus } from '../../model/types.ts';
import type { ParsedFile } from '../../adapters/language/types.ts';
import type { GitCommit } from '../../adapters/git/git-adapter.ts';
import type { Repository } from '../../model/types.ts';
import { compareStrings, shortHash } from '../../model/canonical.ts';
import { redactSecrets } from '../../adapters/filesystem/sensitive.ts';
import { truncate, formatDate } from '../../util/text.ts';
import { basename, stem } from '../../util/paths.ts';

const ADR_DIRECTORY = /(^|\/)(adr|adrs|decisions?|architecture\/decisions?)\//i;
const ADR_FILENAME = /^(adr[-_]?)?(\d{2,4})[-_.]|^adr[-_]?\d*[-_.]/i;
const ADR_HEADING = /^(adr[-_ ]?\d{1,4}|decision[-_ ]?\d{1,4})\s*[:\-–—]?\s*(.*)$/i;
const STATUS_PATTERN = /\bstatus\b\s*[:\-]\s*(accepted|proposed|deprecated|superseded|rejected|draft|approved)/i;
const DECISION_SECTION = /\b(decision|decisions|architecture decision|design decision|invariant|invariants|architecture)\b/i;

const STATUS_MAP: Record<string, DecisionStatus> = {
  accepted: 'accepted',
  approved: 'accepted',
  proposed: 'proposed',
  draft: 'proposed',
  deprecated: 'deprecated',
  superseded: 'superseded',
  rejected: 'rejected',
};

export interface DecisionDetectionInput {
  repository: Repository;
  parsed: Map<string, ParsedFile>;
  /** Commits inside the configured git window (empty when git is unavailable). */
  gitCommits: GitCommit[];
  /** Patterns that mark a commit message as an architectural change signal. */
  architectureSignalPatterns: string[];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeStatus(raw: string | undefined): DecisionStatus {
  if (raw === undefined) return 'unknown';
  return STATUS_MAP[raw.toLowerCase()] ?? 'unknown';
}

interface AdrCandidate {
  path: string;
  id: string;
  title: string;
  status: DecisionStatus;
  excerpt: string;
  explicitId: boolean;
}

/** Extracts an ADR from a markdown document, when the document looks like one. */
export function parseAdrDocument(path: string, file: ParsedFile): AdrCandidate | null {
  const headings = readStringArray(file.metadata['markdown.headings']);
  const frontMatter = file.metadata['markdown.frontMatter'];
  const front =
    typeof frontMatter === 'object' && frontMatter !== null ? (frontMatter as Record<string, string>) : {};
  const paragraph =
    typeof file.metadata['markdown.firstParagraph'] === 'string'
      ? (file.metadata['markdown.firstParagraph'] as string)
      : '';
  const firstHeading = headings[0] ?? '';
  const looksLikeAdr =
    ADR_DIRECTORY.test(path) ||
    ADR_FILENAME.test(basename(path)) ||
    ADR_HEADING.test(firstHeading) ||
    front.status !== undefined;
  if (!looksLikeAdr) return null;

  const filenameDigits = /(\d{2,4})/.exec(stem(path));
  const headingMatch = ADR_HEADING.exec(firstHeading);
  let id: string | null = null;
  if (filenameDigits !== null) id = `ADR-${filenameDigits[1]!.padStart(3, '0')}`;
  else if (headingMatch !== null && /\d/.test(headingMatch[1]!)) {
    id = `ADR-${headingMatch[1]!.replace(/[^0-9]/g, '').padStart(3, '0')}`;
  } else if (front.id !== undefined) id = front.id.toUpperCase();

  const cleanedHeading = headingMatch !== null ? headingMatch[2]! : firstHeading;
  const title = (front.title ?? cleanedHeading).trim();
  const status = normalizeStatus(front.status ?? STATUS_PATTERN.exec(paragraph)?.[1]);
  const excerptSource = paragraph.length > 0 ? paragraph : title;
  return {
    path,
    id: id ?? `ADR-${shortHash(path, 6).toUpperCase()}`,
    title: title.length > 0 ? title : `Decision recorded in ${path}`,
    status,
    excerpt: truncate(redactSecrets(excerptSource), 320),
    explicitId: id !== null,
  };
}

/** Explicit decisions: ADR documents and dedicated architecture documentation. */
export function detectExplicitDecisions(input: DecisionDetectionInput): Decision[] {
  const decisions: Decision[] = [];
  const markdownFiles = [...input.parsed.values()]
    .filter((file) => file.language === 'markdown')
    .sort((a, b) => compareStrings(a.path, b.path));

  for (const file of markdownFiles) {
    const adr = parseAdrDocument(file.path, file);
    if (adr === null) continue;
    decisions.push({
      id: adr.id,
      title: truncate(adr.title, 160),
      status: adr.status,
      source: adr.path,
      origin: 'explicit',
      kind: 'adr',
      confidence: adr.status === 'unknown' ? 0.7 : 0.95,
      evidence: [
        {
          source: adr.path,
          detail: adr.explicitId ? 'document carries an ADR identifier' : 'document lives in a decision directory',
        },
        {
          source: adr.path,
          detail:
            adr.status === 'unknown'
              ? 'no explicit status found in front matter or body'
              : `status found in the document: ${adr.status}`,
        },
      ],
      excerpt: adr.excerpt,
    });
  }

  // Decision-like sections inside regular documentation (README, docs/*).
  for (const file of markdownFiles) {
    if (parseAdrDocument(file.path, file) !== null) continue;
    const headingDetails = file.metadata['markdown.headingDetails'];
    if (!Array.isArray(headingDetails)) continue;
    for (const heading of headingDetails as Array<{ level: number; title: string; line: number }>) {
      if (heading.level > 3 || !DECISION_SECTION.test(heading.title)) continue;
      const isDedicatedDoc = /(^|\/)(architecture|design)(\.|\/)/i.test(file.path);
      decisions.push({
        id: `DOC-${shortHash(`${file.path}:${heading.line}`, 6).toUpperCase()}`,
        title: truncate(heading.title, 160),
        status: 'unknown',
        source: `${file.path}#L${heading.line}`,
        origin: isDedicatedDoc ? 'explicit' : 'inferred',
        kind: 'documented-section',
        confidence: isDedicatedDoc ? 0.6 : 0.45,
        evidence: [
          { source: file.path, detail: `section "${heading.title}" (line ${heading.line}) matched decision vocabulary` },
          {
            source: file.path,
            detail: isDedicatedDoc
              ? 'document is a dedicated architecture document'
              : 'section may describe design context rather than a decision; verify before treating it as an ADR',
          },
        ],
      });
      break;
    }
  }

  return decisions;
}

/** Configuration and dependency facts presented as *inferred* decisions. */
export function detectConfigDecisions(input: DecisionDetectionInput): Decision[] {
  const decisions: Decision[] = [];
  const workspace = input.repository.workspace;

  if (workspace.rootPackage !== null) {
    decisions.push({
      id: 'INF-MODULE-FORMAT',
      title:
        workspace.rootPackage.type === 'module'
          ? 'Packages use ES modules ("type": "module")'
          : 'Packages use CommonJS ("type": "commonjs")',
      status: 'accepted',
      source: 'package.json',
      origin: 'inferred',
      kind: 'config-signal',
      confidence: 0.9,
      evidence: [{ source: 'package.json', detail: `"type": "${workspace.rootPackage.type ?? 'commonjs'}"` }],
    });
  }

  if (workspace.packageManager !== 'unknown') {
    decisions.push({
      id: 'INF-PACKAGE-MANAGER',
      title: `Repository is maintained with ${workspace.packageManager}`,
      status: 'accepted',
      source: workspace.lockfiles[0] ?? 'package.json',
      origin: 'inferred',
      kind: 'config-signal',
      confidence: 0.8,
      evidence: workspace.packageManagerEvidence.slice(0, 3),
    });
  }

  if (workspace.isMonorepo) {
    decisions.push({
      id: 'INF-WORKSPACES',
      title: `Repository is organised as a workspace monorepo (${workspace.workspaceGlobs.join(', ')})`,
      status: 'accepted',
      source: 'package.json',
      origin: 'inferred',
      kind: 'config-signal',
      confidence: 0.95,
      evidence: [{ source: 'package.json', detail: `workspaces: ${workspace.workspaceGlobs.join(', ')}` }],
    });
  }

  const strictConfigs = [...input.parsed.values()].filter((file) => file.metadata['tsconfig.strict'] === true);
  if (strictConfigs.length > 0) {
    decisions.push({
      id: 'INF-STRICT-TS',
      title: 'TypeScript strict mode is mandatory',
      status: 'accepted',
      source: strictConfigs[0]!.path,
      origin: 'inferred',
      kind: 'config-signal',
      confidence: 0.95,
      evidence: strictConfigs.slice(0, 3).map((file) => ({ source: file.path, detail: '"strict": true' })),
    });
  }

  const noteworthy = input.repository.externalDependencies.filter(
    (entry) => entry.importance.value === 'framework' || entry.importance.value === 'infrastructure',
  );
  for (const dependency of noteworthy.slice(0, 4)) {
    decisions.push({
      id: `INF-DEP-${dependency.name.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase()}`,
      title: `The repository builds on ${dependency.name} (heuristic: ${dependency.importance.value})`,
      status: 'accepted',
      source: 'package.json',
      origin: 'inferred',
      kind: 'dependency-signal',
      confidence: Math.min(dependency.importance.confidence, 0.7),
      evidence: [
        { source: 'package.json', detail: `declared by ${dependency.declaredBy.join(', ') || 'the source code'}` },
        { source: '<graph>', detail: `imported by ${dependency.importedByModules} module(s)` },
      ],
    });
  }

  return decisions;
}

/** Architectural change signals from git history, clearly marked as inferred. */
export function detectGitDecisions(input: DecisionDetectionInput): Decision[] {
  if (input.architectureSignalPatterns.length === 0) return [];
  const patterns = input.architectureSignalPatterns.map((pattern) => pattern.toLowerCase());
  const signals: Decision[] = [];
  const sortedCommits = [...input.gitCommits].sort((a, b) => b.dateMs - a.dateMs);
  for (const commit of sortedCommits) {
    const subject = commit.subject.toLowerCase();
    if (!patterns.some((pattern) => subject.includes(pattern))) continue;
    signals.push({
      id: `GIT-${commit.sha.slice(0, 8)}`,
      title: truncate(redactSecrets(commit.subject), 160),
      status: 'unknown',
      source: `git:${commit.sha.slice(0, 8)}`,
      origin: 'inferred',
      kind: 'git-signal',
      confidence: 0.45,
      evidence: [
        {
          source: `git:${commit.sha.slice(0, 8)}`,
          detail: `commit message matched an architectural keyword (${formatDate(commit.dateMs)}, ${commit.files.length} file(s) changed)`,
        },
      ],
    });
    if (signals.length >= 5) break;
  }
  return signals;
}

/** Runs every decision detector; explicit decisions win id conflicts. */
export function detectDecisions(input: DecisionDetectionInput): Decision[] {
  const combined = [...detectExplicitDecisions(input), ...detectConfigDecisions(input), ...detectGitDecisions(input)];
  const seenIds = new Set<string>();
  const result: Decision[] = [];
  for (const decision of combined) {
    if (seenIds.has(decision.id)) continue;
    seenIds.add(decision.id);
    result.push(decision);
  }
  return result.sort((a, b) => (a.origin === b.origin ? compareStrings(a.id, b.id) : a.origin === 'explicit' ? -1 : 1));
}

/** Paths of ADR documents, used by `explain` and search. */
export function collectAdrPaths(parsed: Map<string, ParsedFile>): string[] {
  return [...parsed.values()]
    .filter((file) => file.language === 'markdown' && parseAdrDocument(file.path, file) !== null)
    .map((file) => file.path)
    .sort(compareStrings);
}