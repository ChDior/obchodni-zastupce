import { resolve } from 'node:path';
import { bootstrap } from './bootstrap.js';
const { db } = await bootstrap({ dataDir: process.env.DATA_DIR });
console.log('Seed hotov.');
await db.close();
void resolve;
