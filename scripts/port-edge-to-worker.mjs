// Port the cron-invoked Edge Functions into worker/src/jobs/.
//
// The handler logic is copied verbatim; only the runtime shell changes:
//   - jsr:/esm.sh imports        -> npm package imports
//   - Deno.env.get(...)          -> env(...) from worker/src/lib/env.ts
//   - Deno.serve(withHealthLog(  -> export default defineJob(
//   - per-function ./supabase.ts -> single ../../lib/supabase.ts
//   - declare const EdgeRuntime  -> import of the waitUntil shim
//
// Re-run any time the Edge sources change while both implementations coexist:
//   node scripts/port-edge-to-worker.mjs
//
// Files listed in HAND_EDITED keep their worker-side copies (they diverge
// deliberately — e.g. nws-poll drops the self-reinvoking follow-up poll).
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'supabase', 'functions');
const DST = join(root, 'worker', 'src', 'jobs');

// Functions that move into the worker. telegram-webhook and signup stay as
// Edge Functions — they are public HTTPS endpoints, not cron jobs.
const JOBS = [
  'afd-poll',
  'cap-dispatcher',
  'couplet-dispatcher',
  'couplet-poll',
  'daily-forecast',
  'event-recap',
  'health-monitor',
  'librewxr-poll',
  'lsr-poll',
  'nws-dispatcher',
  'nws-poll',
  'scheduled-dispatcher',
  'spc-poll',
  'telegram-send-worker',
];

// worker-side files that have intentional divergences; never overwrite.
const HAND_EDITED = new Set([
  'nws-poll/index.ts', // follow-up self-poll removed; scheduler runs it at 30s
]);

function transform(code) {
  let out = code;

  out = out.replaceAll("'jsr:@supabase/supabase-js@2'", "'@supabase/supabase-js'");
  // rrule's npm package is CJS whose named exports Node's ESM loader can't
  // statically detect — default-import and destructure instead.
  out = out.replace(
    /import\s*\{([^}]+)\}\s*from\s*'https:\/\/esm\.sh\/rrule@2\.8\.1';/g,
    "import rrulePkg from 'rrule';\nconst {$1} = rrulePkg;",
  );
  out = out.replaceAll("'./_shared/supabase.ts'", "'../../lib/supabase.ts'");
  out = out.replaceAll("'./supabase.ts'", "'../../lib/supabase.ts'");
  out = out.replaceAll("'./_shared/telegram.ts'", "'../../lib/telegram.ts'");

  // withHealthLog is applied by the harness now; drop it from import lists.
  out = out.replace(/,\s*withHealthLog/g, '').replace(/withHealthLog\s*,\s*/g, '');

  out = out.replace(
    /declare const EdgeRuntime[^;]*;/g,
    "import { EdgeRuntime } from '../../lib/edge-runtime.ts';",
  );

  const needsDefineJob = out.includes('Deno.serve(withHealthLog(');
  if (needsDefineJob) {
    out = out.replace('Deno.serve(withHealthLog(', 'export default defineJob(');
    // Deno.serve(withHealthLog(...)) closed with `}));` — defineJob(...) needs `});`
    const tail = out.lastIndexOf('}));');
    if (tail === -1) throw new Error('expected closing `}));` after Deno.serve');
    out = out.slice(0, tail) + '});' + out.slice(tail + 4);
  }

  const envCount = (out.match(/Deno\.env\.get\(/g) ?? []).length;
  out = out.replaceAll('Deno.env.get(', 'env(');

  if (out.includes('Deno.')) {
    throw new Error(`unhandled Deno API remains: ${out.match(/Deno\.[a-zA-Z.]+/)?.[0]}`);
  }

  const header = [];
  if (needsDefineJob) header.push("import { defineJob } from '../../lib/harness.ts';");
  if (envCount > 0) header.push("import { env } from '../../lib/env.ts';");
  if (header.length) out = header.join('\n') + '\n' + out;

  return out;
}

for (const job of JOBS) {
  const srcDir = join(SRC, job);
  const dstDir = join(DST, job);
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    // the per-function supabase.ts duplicates collapse into worker/src/lib/supabase.ts
    if (entry.name === 'supabase.ts') continue;
    if (HAND_EDITED.has(`${job}/${entry.name}`) && existsSync(join(dstDir, entry.name))) {
      console.log(`skip (hand-edited): ${job}/${entry.name}`);
      continue;
    }
    const code = readFileSync(join(srcDir, entry.name), 'utf8');
    writeFileSync(join(dstDir, entry.name), transform(code));
    console.log(`ported: ${job}/${entry.name}`);
  }
}
