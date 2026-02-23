import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqliteMemoryStore } from './sqlite-store.js';
import type { ExtractFn } from './types.js';
import { extract as defaultExtract } from './providers/extract.js';
import { normalizeAgentId } from './utils.js';

const MAX_CHUNK_CHARS = 12_000;

interface Chunk {
  text: string;
  source: string;
  index: number;
}

export interface IngestDocumentsResult {
  ingested: number;
  chunks: number;
  stored: number;
  skipped: number;
  errors: string[];
  agent: string;
}

/**
 * Strip YAML frontmatter (---...---) from the beginning of markdown content.
 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Split markdown content into chunks by headings, with paragraph-level sub-splitting
 * for sections that exceed MAX_CHUNK_CHARS.
 */
export function chunkMarkdown(content: string, filePath: string): Chunk[] {
  const stripped = stripFrontmatter(content).trim();
  if (!stripped) return [];

  // Split on headings (# through ###)
  const sections: Array<{ heading: string; body: string }> = [];
  const headingRegex = /^(#{1,3})\s+(.+)$/gm;
  let lastIndex = 0;
  let lastHeading = '';
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(stripped)) !== null) {
    // Capture text before this heading
    if (match.index > lastIndex) {
      const body = stripped.slice(lastIndex, match.index).trim();
      if (body) {
        sections.push({ heading: lastHeading, body });
      }
    }
    lastHeading = match[0];
    lastIndex = match.index + match[0].length;
  }

  // Capture remaining text after last heading
  const remaining = stripped.slice(lastIndex).trim();
  if (remaining) {
    sections.push({ heading: lastHeading, body: remaining });
  }

  // If no headings were found, treat entire content as one section
  if (sections.length === 0) {
    sections.push({ heading: '', body: stripped });
  }

  // Build chunks, splitting large sections at paragraph boundaries
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const fullText = section.heading ? `${section.heading}\n\n${section.body}` : section.body;

    if (fullText.length <= MAX_CHUNK_CHARS) {
      chunks.push({ text: fullText, source: filePath, index: chunkIndex++ });
    } else {
      // Split at paragraph boundaries
      const paragraphs = section.body.split(/\n\n+/);
      let current = section.heading ? `${section.heading}\n\n` : '';

      for (const para of paragraphs) {
        if (current.length + para.length + 2 > MAX_CHUNK_CHARS && current.trim()) {
          chunks.push({ text: current.trim(), source: filePath, index: chunkIndex++ });
          current = section.heading ? `${section.heading} (cont.)\n\n` : '';
        }
        current += para + '\n\n';
      }

      if (current.trim()) {
        chunks.push({ text: current.trim(), source: filePath, index: chunkIndex++ });
      }
    }
  }

  return chunks;
}

/**
 * Recursively collect all .md files from a directory path, sorted alphabetically.
 * If path is a single file, return it.
 */
async function collectMarkdownFiles(dirPath: string): Promise<string[]> {
  const stat = await fs.stat(dirPath);

  if (stat.isFile()) {
    if (dirPath.endsWith('.md')) return [dirPath];
    return [];
  }

  const files: string[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

/**
 * Ingest markdown documents from a directory (or single file) into the memory store.
 */
export async function ingestDocuments(
  dirPath: string,
  store: SqliteMemoryStore,
  agent?: string,
  extractFn?: ExtractFn,
): Promise<IngestDocumentsResult> {
  const resolvedPath = path.resolve(dirPath);
  const files = await collectMarkdownFiles(resolvedPath);
  const basePath = (await fs.stat(resolvedPath)).isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const doExtract = extractFn ?? defaultExtract;

  let totalChunks = 0;
  let totalStored = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, 'utf-8');
    if (!content.trim()) continue;

    const relativePath = path.relative(basePath, filePath);
    const chunks = chunkMarkdown(content, relativePath);
    totalChunks += chunks.length;

    for (const chunk of chunks) {
      try {
        const components = await doExtract(chunk.text);
        if (!components) {
          totalSkipped++;
          continue;
        }

        const rows = await store.ingest(components, agent, {
          source: chunk.source,
          deduplicate: true,
        });

        if (rows.length > 0) {
          totalStored += rows.length;
        } else {
          totalSkipped++;
        }
      } catch (err: any) {
        errors.push(`${chunk.source}[${chunk.index}]: ${err.message ?? 'extraction failed'}`);
      }
    }
  }

  return {
    ingested: files.length,
    chunks: totalChunks,
    stored: totalStored,
    skipped: totalSkipped,
    errors,
    agent: normalizeAgentId(agent),
  };
}
