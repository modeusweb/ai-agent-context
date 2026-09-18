/**
 * Markdown adapter.
 *
 * Markdown is where repositories already document their conventions, decisions
 * and architecture. The adapter extracts structure (headings, links, section
 * positions) so that the decision and convention detectors can attach evidence
 * to real documents instead of guessing.
 */
import { createParsedFile, type FileDescriptor, type LanguageAdapter, type ParsedFile } from '../types.ts';

export interface MarkdownHeading {
  level: number;
  title: string;
  line: number;
  /** Heading text in lowercase, for cheap section matching. */
  normalized: string;
}

export interface MarkdownLink {
  text: string;
  target: string;
  line: number;
}

export function extractHeadings(contents: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = contents.split('\n');
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match === null) continue;
    const title = match[2]!.replace(/[#\s]+$/, '').trim();
    headings.push({
      level: match[1]!.length,
      title,
      line: index + 1,
      normalized: title.toLowerCase(),
    });
  }
  return headings;
}

export function extractMarkdownLinks(contents: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const lines = contents.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const pattern = /\[([^\]]{0,120})\]\(([^)\s]{1,400})\)/g;
    let match = pattern.exec(line);
    while (match !== null) {
      links.push({ text: match[1]!, target: match[2]!, line: index + 1 });
      match = pattern.exec(line);
    }
  }
  return links;
}

/** First non-empty paragraph after the front matter, used as a short excerpt. */
export function firstParagraph(contents: string): string {
  const body = stripFrontMatter(contents);
  const lines = body.split('\n');
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('|')) {
      if (collected.length > 0) break;
      continue;
    }
    if (trimmed.length === 0) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(trimmed);
  }
  return collected.join(' ').slice(0, 480);
}

/** Removes a YAML front matter block, when present. */
export function stripFrontMatter(contents: string): string {
  if (!contents.startsWith('---')) return contents;
  const end = contents.indexOf('\n---', 3);
  if (end === -1) return contents;
  return contents.slice(end + 4);
}

export function extractFrontMatter(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!contents.startsWith('---')) return result;
  const end = contents.indexOf('\n---', 3);
  if (end === -1) return result;
  const block = contents.slice(3, end);
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    result[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return result;
}

export class MarkdownAdapter implements LanguageAdapter {
  readonly id = 'markdown';
  readonly displayName = 'Markdown';
  readonly languageIds: readonly string[] = ['markdown', 'md'];
  readonly alwaysEnabled = true;

  handles(file: FileDescriptor): boolean {
    return file.extension === '.md' || file.extension === '.mdx' || file.extension === '.markdown';
  }

  parse(input: { path: string; language: string; contents: string }): ParsedFile {
    const headings = extractHeadings(input.contents);
    const links = extractMarkdownLinks(input.contents);
    const frontMatter = extractFrontMatter(input.contents);
    const documentLinks = links
      .map((link) => link.target)
      .filter((target) => target.endsWith('.md') && !/^https?:/i.test(target));
    return createParsedFile(input.path, 'markdown', {
      signals: headings.some((heading) => /decision|architecture|adr/.test(heading.normalized)) ? ['docs:decisions'] : [],
      metadata: {
        'markdown.headings': headings.map((heading) => heading.title),
        'markdown.headingDetails': headings,
        'markdown.title': headings[0]?.title ?? '',
        'markdown.documentLinks': [...new Set(documentLinks)].sort(),
        'markdown.frontMatter': frontMatter,
        'markdown.firstParagraph': firstParagraph(input.contents),
        'markdown.lineCount': input.contents.split('\n').length,
      },
    });
  }
}