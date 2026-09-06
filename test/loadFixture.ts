import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads a committed fixture from `test/fixtures/<name>` as parsed JSON.
 *
 * Deliberately `fs.readFileSync` + `JSON.parse` rather than a native JSON module import:
 * a native import needs `resolveJsonModule` in `tsconfig.json`, and this change's only
 * approved edit to that file is adding `scripts/**\/*.ts` to `include` (design.md,
 * "Coordination with `tooling-and-ci`"). This keeps fixture loading independent of any
 * further tsconfig change.
 */
export function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}
