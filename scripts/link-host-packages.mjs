// Recreates `node_modules/@deepseek-ai/*` symlinks pointing at the sibling
// `deepseek-harness` workspace packages.
//
// Why: dsh-okf is a plugin whose `@deepseek-ai/*` peer deps are provided by the
// host at runtime (tsdown `neverBundle`). `npm install` prunes node_modules and
// reinstalls the published (older) registry copies of those peers, which drift
// from the workspace source and break `tsc`. This script runs on every install
// (see `postinstall`) and re-links the exact workspace source, so type-checking
// and the built plugin always agree with the host.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(root, '..', 'deepseek-harness');
const scopedDir = join(root, 'node_modules', '@deepseek-ai');

if (!existsSync(join(host, 'package.json'))) {
  console.error(`[link-host-packages] host workspace not found at ${host}; skipping.`);
  process.exit(0);
}

// Descend until a package.json is found (workspace packages live at
// packages/<group>/<name> and vendor/<name>); cap depth to stay cheap.
function* collectPackages(base, depth) {
  if (depth <= 0 || !existsSync(base)) return;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fp = join(base, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(fp, 'package.json'))) {
      yield fp;
    } else {
      yield* collectPackages(fp, depth - 1);
    }
  }
}

const found = [];
for (const base of ['packages', 'vendor']) {
  for (const fp of collectPackages(join(host, base), 5)) {
    try {
      const { name } = JSON.parse(readFileSync(join(fp, 'package.json'), 'utf8'));
      if (name?.startsWith('@deepseek-ai/')) found.push([name, fp]);
    } catch {
      // unreadable package.json — ignore
    }
  }
}

mkdirSync(scopedDir, { recursive: true });
let linked = 0;
for (const [name, target] of found) {
  const link = join(scopedDir, name.slice('@deepseek-ai/'.length));
  if (existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, 'dir');
  linked++;
}
console.log(`[link-host-packages] linked ${linked} @deepseek-ai/* packages -> ${host}`);
