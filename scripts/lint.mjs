import { readdir, readFile } from 'node:fs/promises';
let failed = false;
async function check(directory) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${file.name}`;
    if (file.isDirectory()) { if (file.name !== 'node_modules') await check(path); continue; }
    if (!/\.(ts|mjs|sql|json|ya?ml)$/.test(path)) continue;
    const text = await readFile(path, 'utf8');
    if (/\r|[ \t]+\n/.test(text) || !text.endsWith('\n')) { console.error(`format: ${path}`); failed = true; }
    if (!process.argv.includes('--format') && path.endsWith('.ts') && /@ts-ignore|\bas any\b|:\s*any\b|console\.(log|error)/.test(text)) {
      console.error(`unsafe escape/log: ${path}`); failed = true;
    }
  }
}
for (const dir of ['apps', 'packages', 'db', 'infra', 'tests/foundation', 'tests/payment', 'tests/buyer', 'examples', 'tests/fulfillment', 'tests/operator', 'tests/hardening', '.github/workflows']) await check(dir);
if (failed) process.exitCode = 1;
else console.log('source_hygiene_passed (strict compiler supplies type lint; no general formatter configured)');
