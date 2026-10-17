/**
 * Trust metrics: how much of the output is explainable, and whether it repeats.
 *
 * These answer two questions the rest of the benchmark cannot:
 *
 *   - **evidence coverage** — of everything the analyzer asserts as a judgement,
 *     how much can it cite? A heuristic with no evidence is a guess wearing the
 *     same clothes as a measurement, and the ratio is what separates the two.
 *   - **determinism** — does the same tree produce the same bytes twice? The
 *     project commits `.agent/` and diffs it across releases, so a context that
 *     varies without the repository varying is a defect, not noise.
 *
 * Both are computed from the documents the tool actually wrote, never from the
 * inputs, so neither can be satisfied by the analyzer agreeing with itself.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DOCS = ['index.json', 'architecture.json', 'dependencies.json', 'conventions.json', 'decisions.json'];

/**
 * Walks documents and collects every judgement: an object carrying a numeric
 * `confidence`, which is exactly the shape the analyzer uses for a heuristic.
 * Structural facts (module ids, file paths, import specifiers) have no
 * confidence and are deliberately not counted.
 */
export function collectJudgements(documents) {
  const withEvidence = [];
  const withoutEvidence = [];

  const visit = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${where}[${index}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;

    const isJudgement = typeof node.confidence === 'number';
    if (isJudgement) {
      const evidence = Array.isArray(node.evidence) ? node.evidence.filter((e) => e !== null && e !== undefined) : [];
      const label = `${where}:${node.value ?? node.kind ?? node.category ?? node.id ?? node.path ?? node.name ?? ''}`;
      if (evidence.length > 0) withEvidence.push(label);
      else withoutEvidence.push(label);
    }
    for (const [key, value] of Object.entries(node)) visit(value, `${where}.${key}`);
  };

  for (const [name, document] of Object.entries(documents)) visit(document, name);
  return { withEvidence, withoutEvidence };
}

/** Evidence coverage across every heuristic the analyzer emitted. */
export function evidenceCoverage(documents) {
  const { withEvidence, withoutEvidence } = collectJudgements(documents);
  const total = withEvidence.length + withoutEvidence.length;
  return {
    judgements: total,
    withEvidence: withEvidence.length,
    withoutEvidence: withoutEvidence.length,
    // A repository with no heuristics at all must not report a perfect score:
    // there was nothing to explain.
    coverage: total === 0 ? null : Number(((withEvidence.length / total) * 100).toFixed(1)),
    samples: withoutEvidence.slice(0, 5),
  };
}

/**
 * Hashes the generated documents so two scans can be compared without keeping
 * both copies. Includes file names so a missing document changes the result.
 */
export function hashDocuments(root) {
  const parts = [];
  for (const name of DOCS) {
    const file = path.join(root, '.agent', name);
    if (!existsSync(file)) {
      parts.push(`${name}:MISSING`);
      continue;
    }
    parts.push(`${name}:${readFileSync(file, 'utf8')}`);
  }
  let hash = 0x811c9dc5;
  for (const part of parts.join('\n')) {
    hash ^= part.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}