// Both drivers expose the same small, async pg-compatible connection interface.
// PGlite is PostgreSQL running locally in WASM; it is never a production fallback.
export async function createDatabase({ env = process.env, localPath } = {}) {
  if (env.RPG_DSQL_HOST) {
    const [{ default: pg }, { DsqlSigner }] = await Promise.all([import('pg'), import('@aws-sdk/dsql-signer')]);
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
    if (!region) throw Error('AWS_REGION is required for Aurora DSQL');
    const signer = new DsqlSigner({ hostname: env.RPG_DSQL_HOST, region });
    const user = env.RPG_DSQL_USER || 'rpg_app';
    const pool = new pg.Pool({ host: env.RPG_DSQL_HOST, port: 5432, database: 'postgres', user,
      password: () => user === 'admin' ? signer.getDbConnectAdminAuthToken() : signer.getDbConnectAuthToken(),
      ssl: { rejectUnauthorized: true }, max: 2, idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000, maxLifetimeSeconds: 840, allowExitOnIdle: true });
    pool.on('error', error => console.error('Idle DSQL connection failed:', error.code || error.name));
    return { dialect: 'dsql', connect: () => pool.connect(), close: () => pool.end() };
  }
  if (env.AWS_LAMBDA_FUNCTION_NAME) throw Error('Lambda requires RPG_DSQL_HOST and AWS_REGION');
  if (env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4, allowExitOnIdle: true });
    pool.on('error', error => console.error('Idle PostgreSQL connection failed:', error.code || error.name));
    return { dialect: 'postgres', connect: () => pool.connect(), close: () => pool.end() };
  }
  if (env.AWS_LAMBDA_FUNCTION_NAME || !localPath) throw Error('Configure RPG_DSQL_HOST and AWS_REGION; Lambda requires Aurora DSQL');
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(localPath === ':memory:' ? undefined : localPath);
  await db.waitReady;
  // A single local engine connection must own a whole transaction at a time.
  let tail = Promise.resolve();
  return { dialect: 'pglite', async connect() {
    const prior = tail; let unlock; tail = new Promise(resolve => { unlock = resolve; }); await prior;
    return { query: (sql, values = []) => db.query(sql, values), release: unlock };
  }, close: () => db.close() };
}
