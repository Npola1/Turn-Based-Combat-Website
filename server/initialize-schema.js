import { readFile } from 'node:fs/promises';

export async function initializeSchema(database) {
  const source = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const client = await database.connect();
  try {
    // DSQL DDL is applied separately, never mixed into save transactions.
    for (const statement of source.split(';').map(s => s.trim()).filter(Boolean)) await client.query(statement);
    for (const [name, table, columns] of [
      ['battles_player', 'battles', 'player_id, started_at'],
      ['expired_requests', 'request_chunks', 'created_at'],
      ['expired_responses', 'response_chunks', 'created_at']
    ]) {
      const exists = await client.query('SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2', ['public', name]);
      if (exists.rows.length) continue;
      const result = await client.query(`CREATE INDEX ${database.dialect === 'dsql' ? 'ASYNC ' : ''}${name} ON ${table} (${columns})`);
      if (database.dialect === 'dsql') {
        const job = result.rows[0]?.job_id;
        if (!job) throw Error('DSQL index creation did not return a job ID: ' + name);
        await client.query('SELECT sys.wait_for_job($1)', [job]);
      }
    }
  } finally { client.release(); }
}
