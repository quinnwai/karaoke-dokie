import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// Turbopack refuses a node_modules symlink that points outside the project root
// (as in git worktrees sharing one install). Widen the root to the common parent.
function turbopackRoot(): string {
  const here = process.cwd();
  let modules = here;
  try {
    modules = path.dirname(realpathSync(path.join(here, 'node_modules')));
  } catch {}
  let root = here;
  while (!modules.startsWith(root + path.sep) && modules !== root) root = path.dirname(root);
  return root;
}

const nextConfig: NextConfig = {
  turbopack: { root: turbopackRoot() },
};

export default nextConfig;
