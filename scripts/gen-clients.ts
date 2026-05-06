/**
 * scripts/gen-clients.ts
 *
 * Generate typed Kit clients from Anchor v1 IDL JSON via Codama.
 * Verified working stack (Phase 0 spike, 2026-05-04):
 *   codama@^1.6
 *   @codama/nodes-from-anchor@^1.4
 *   @codama/renderers-js@^2.2 — exports `renderVisitor` (NOT `renderJavaScriptVisitor`)
 *
 * Generated output structure (per program):
 *   <out>/<program>/programs/
 *   <out>/<program>/instructions/
 *   <out>/<program>/accounts/
 *   <out>/<program>/pdas/
 *   <out>/<program>/errors/
 *
 * Run: `pnpm gen-clients`.
 *
 * Implementation note: this file uses Node 22+'s native `--experimental-strip-types`
 * (set in the root `package.json` `gen-clients` script) so we can write `.ts`
 * directly without a build step.
 */

import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const IDL_DIR = resolve(REPO_ROOT, 'contracts', 'target', 'idl');

const PROGRAMS = ['governance', 'vault', 'flight_pool', 'oracle_aggregator', 'controller'] as const;

const OUT_DIRS = [
  resolve(REPO_ROOT, 'frontend', 'src', 'clients'),
  resolve(REPO_ROOT, 'executor', 'src', 'clients'),
  // Tests in `contracts/tests/` consume the same Codama-typed clients to
  // avoid hand-rolling instruction discriminators (see Phase 1 D9).
  resolve(REPO_ROOT, 'contracts', 'tests', 'clients'),
  // Phase 7 (deploy script) consumes the typed clients to wire all 5
  // programs' init / set_controller / set_authorized_consumer ix.
  resolve(REPO_ROOT, 'scripts', 'clients'),
] as const;

async function generateForProgram(programName: string, idlPath: string) {
  const raw = readFileSync(idlPath, 'utf-8');
  const idl = JSON.parse(raw);

  const codama = createFromRoot(rootNodeFromAnchor(idl));

  for (const outRoot of OUT_DIRS) {
    const outDir = resolve(outRoot, programName);
    mkdirSync(outDir, { recursive: true });
    await codama.accept(renderVisitor(outDir));
    // eslint-disable-next-line no-console
    console.log(`[gen-clients] ${programName} → ${outDir}`);
  }
}

async function main() {
  if (!existsSync(IDL_DIR)) {
    console.error(`[gen-clients] IDL dir missing: ${IDL_DIR}\n  Run \`pnpm sync-idl\` first (or \`anchor build\` in contracts/).`);
    process.exit(1);
  }

  for (const program of PROGRAMS) {
    const idlPath = resolve(IDL_DIR, `${program}.json`);
    if (!existsSync(idlPath)) {
      console.error(`[gen-clients] missing IDL: ${idlPath}`);
      process.exit(1);
    }
    await generateForProgram(program, idlPath);
  }

  console.log(`[gen-clients] OK — generated ${PROGRAMS.length} clients into ${OUT_DIRS.length} workspaces.`);
}

main().catch((err) => {
  console.error('[gen-clients] failed:', err);
  process.exit(1);
});
