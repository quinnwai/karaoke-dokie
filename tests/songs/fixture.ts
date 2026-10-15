import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads a handwritten UltraStar file from tests/fixtures/ultrastar. */
export const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures/ultrastar', name), 'utf8');
