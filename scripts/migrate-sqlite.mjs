// Run explicitly, after db:init, against a new unused DSQL database.
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../server/database.js';
import { importLegacy } from '../server/import-legacy.js';
if(!process.env.RPG_DSQL_HOST)throw Error('Set RPG_DSQL_HOST and AWS_REGION for the empty destination cluster');
const path=process.argv[2];if(!path)throw Error('Usage: npm run db:migrate -- /absolute/path/to/backup/game.sqlite');
const source=new DatabaseSync(resolve(path),{readOnly:true});let legacy;
try{source.exec('BEGIN');legacy=Object.fromEntries(['players','battles','saves','inventory','combat_decisions'].map(t=>[t,source.prepare('SELECT * FROM '+t).all()]));source.exec('COMMIT');}finally{source.close();}
const database=await createDatabase({env:{...process.env,RPG_DSQL_USER:'admin'}});
try{console.log('Imported:',await importLegacy(database,legacy));}finally{await database.close();}
