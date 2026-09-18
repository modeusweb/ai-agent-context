/**
 * Human readable projection of the conventions.
 *
 * The canonical machine-readable representation is `.agent/conventions.json`; this
 * Markdown file is generated *from* it for humans reading the repository. Every
 * statement shows its confidence and the evidence that supports it.
 */
import type { Convention } from '../../model/types.ts';
import { GENERATOR_NAME, SCHEMA_VERSION } from '../../model/schema.ts';

export interface ConventionsMarkdownMeta {
  repositoryName: string;
  /** Optional ISO timestamp; omitted by default so the file stays diff-stable. */
  generatedAt?: string;
}

/** Renders `.agent/conventions.md` deterministically. */
export function renderConventionsMarkdown(
  conventions: readonly Convention[],
  meta: ConventionsMarkdownMeta,
): string {
  const lines: string[] = [];
  lines.push('# Repository Conventions');
  lines.push('');
  lines.push(`Observed in \`${meta.repositoryName}\` by ${GENERATOR_NAME} (schema v${SCHEMA_VERSION}).`);
  lines.push('');
  lines.push(
    'Each statement is a counted observation over the repository, not a guess: the confidence and the',
  );
  lines.push('evidence behind it are listed. Statements marked `config` come from declared configuration files.');
  lines.push('');
  if (meta.generatedAt !== undefined) {
    lines.push(`Generated at: ${meta.generatedAt}`);
    lines.push('');
  }

  const categories: string[] = [];
  for (const convention of conventions) {
    if (!categories.includes(convention.category)) categories.push(convention.category);
  }

  if (categories.length === 0) {
    lines.push('_No conventions were detected: the repository is either too small or has no analyzable source files._');
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  for (const category of categories) {
    lines.push(`## ${category}`);
    lines.push('');
    for (const convention of conventions.filter((entry) => entry.category === category)) {
      lines.push(`- ${convention.statement} _(confidence ${convention.confidence.toFixed(2)}, ${convention.origin})_`);
      for (const evidence of convention.evidence) {
        lines.push(`  - evidence: \`${evidence.source}\` — ${evidence.detail}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`Machine readable form: \`.agent/conventions.json\` (schema v${SCHEMA_VERSION}).`);
  return `${lines.join('\n')}\n`;
}