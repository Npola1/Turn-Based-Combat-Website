import {createDatabase} from '../server/database.js';
import {initializeSchema} from '../server/initialize-schema.js';
if(!process.env.RPG_DSQL_HOST||!process.env.RPG_LAMBDA_ROLE_ARN)throw Error('Set RPG_DSQL_HOST, AWS_REGION and RPG_LAMBDA_ROLE_ARN from the stack outputs');
const arn=process.env.RPG_LAMBDA_ROLE_ARN;
if(!/^arn:[a-z-]+:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/.test(arn))throw Error('Invalid Lambda role ARN');
const db=await createDatabase({env:{...process.env,RPG_DSQL_USER:'admin'}});
try{
 await initializeSchema(db);const c=await db.connect();
 try{const role=await c.query('SELECT 1 FROM pg_roles WHERE rolname=$1',['rpg_app']);if(!role.rows.length)await c.query('CREATE ROLE rpg_app WITH LOGIN');
  await c.query('GRANT USAGE ON SCHEMA public TO rpg_app');
  await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO rpg_app');
  await c.query(`AWS IAM GRANT rpg_app TO '${arn}'`);
 }finally{c.release();}
 console.log('Aurora DSQL schema initialized; the Lambda IAM role is mapped to rpg_app.');
}finally{await db.close();}
