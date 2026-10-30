import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const IMPORT_SOURCE = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function violations(directory: string, forbidden: string[]): string[] {
  return sourceFiles(join(process.cwd(), directory)).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(IMPORT_SOURCE)]
      .map((match) => match[1] ?? '')
      .filter((specifier) => forbidden.some((prefix) => specifier.includes(prefix)))
      .map((specifier) => `${file}: ${specifier}`);
  });
}

describe('dependency rules', () => {
  test('application não importa infrastructure', () => {
    expect(violations('src/application', ['/infrastructure/', 'infrastructure/'])).toEqual([]);
  });

  test('presentation não importa infrastructure', () => {
    expect(violations('src/presentation', ['/infrastructure/', 'infrastructure/'])).toEqual([]);
  });

  test('domain e shared não importam camadas externas', () => {
    for (const layer of ['src/domain', 'src/shared']) {
      expect(violations(layer, ['/application/', '/infrastructure/', '/presentation/'])).toEqual(
        []
      );
    }
  });
});
