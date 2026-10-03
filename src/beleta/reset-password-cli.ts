import { bootstrap } from './bootstrap.js';
import { resetPassword } from './auth.js';

const [email, password] = process.argv.slice(2);
if (!email || !password) { console.error('Použití: npm run reset-password -- <email> <nové-heslo (min. 12 znaků)>'); process.exit(1); }
const { db } = await bootstrap({ dataDir: process.env.DATA_DIR, seedDemo: false });
try {
  const ok = await resetPassword(db, email, password);
  console.log(ok ? 'Heslo změněno, všechny relace odhlášeny.' : 'Uživatel s tímto e-mailem neexistuje.');
  process.exitCode = ok ? 0 : 1;
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
await db.close();
