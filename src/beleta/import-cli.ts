import { readFileSync } from 'node:fs';
import { bootstrap } from './bootstrap.js';
import { IMPORT_TYPES, deactivateDemo, importCsv, type ImportType } from './import-csv.js';

const [cmd, file, ...flags] = process.argv.slice(2);
const usage = () => { console.error(`Použití:\n  npm run import -- <${IMPORT_TYPES.join('|')}> <soubor.csv> [--dry-run]\n  npm run import -- deactivate-demo`); process.exit(1); };
if (!cmd) usage();
const { db, core } = await bootstrap({ dataDir: process.env.DATA_DIR ?? '.data/pg', seedDemo: false });
try {
  if (cmd === 'deactivate-demo') console.log(`Vypnuto ukázkových produktů: ${await deactivateDemo(db, core.audit, 'system:import-cli')}`);
  else {
    if (!file || !(IMPORT_TYPES as readonly string[]).includes(cmd)) usage();
    const r = await importCsv(db, core.audit, cmd as ImportType, readFileSync(file, 'utf8'), { dryRun: flags.includes('--dry-run'), by: 'system:import-cli' });
    console.log(JSON.stringify({ ...r, errors: undefined }));
    for (const e of r.errors) console.error(`řádek ${e.line}: ${e.message}`);
    if (r.errors.length) { console.error('Nic nebylo zapsáno – opravte chyby a spusťte znovu.'); process.exitCode = 1; }
    else console.log(r.dry_run ? 'Zkušební běh OK – nic nebylo zapsáno.' : 'Import dokončen.');
  }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
await db.close();
