import { randomUUID } from 'node:crypto';

export class SaveError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const requireValue = (value, message, status) => { if (!value) throw new SaveError(message, status); };
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 100;
const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;
export const TRANSPORT_PART_BYTES = 180 * 1024;
const TEXT_CHUNK_CHARS = 60000; // <= 240KB even for four-byte Unicode characters.

export function validateState(state, inventory) {
  requireValue(state?.schemaVersion === 2 && Array.isArray(state.party) && state.party.length > 0 && state.party.length <= 4 && Array.isArray(state.enemies), 'Invalid checkpoint');
  const f = state.flags;
  requireValue(f?.phase === 'player' && f._inPlayerPhase === true && Number.isInteger(f.currentActorIdx) && f.currentActorIdx >= 0 && f.currentActorIdx < state.party.length && Array.isArray(f._actedThisPhase) && !f._actedThisPhase[f.currentActorIdx], 'Save requires a fresh player turn');
  const actor = state.party[f.currentActorIdx];
  requireValue(actor.alive && actor._turnStarted === true && !actor.guarding, 'Turn-start effects must finish before saving');
  for (const unit of [...state.party, ...state.enemies]) requireValue(isId(unit.name) && Number.isFinite(unit.hp) && unit.hp >= 0 && Number.isFinite(unit.en) && unit.en >= 0 && (!Number.isFinite(unit.maxHP) || unit.hp <= unit.maxHP) && (!Number.isFinite(unit.maxEN) || unit.en <= unit.maxEN) && unit.status && typeof unit.status === 'object' && !Array.isArray(unit.status), 'Invalid character state');
  requireValue(Array.isArray(inventory) && inventory.length <= 100, 'Invalid inventory');
  const keys = new Set();
  for (const item of inventory) {
    requireValue(isId(item.item_id) && Number.isSafeInteger(item.quantity) && item.quantity >= 0 && !keys.has(item.item_id), 'Invalid inventory item'); keys.add(item.item_id);
  }
  requireValue(Number.isSafeInteger(state.sequence) && state.sequence >= 0 && Number.isSafeInteger(state.turn) && state.turn > 0, 'Invalid checkpoint sequence');
}

// All methods are async. Each write touches the owner's revision row so races
// involving history, resumes and different slots conflict together under DSQL OCC.
export function createStore(database, { maxAttempts = 8, delay = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!database?.connect) throw Error('createStore requires an async PostgreSQL/DSQL database');
  async function transaction(task, player = null) {
    for (let attempt = 0; ; attempt++) {
      const client = await database.connect(); let began = false;
      try {
        await client.query(database.dialect==='dsql'?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ'); began = true;
        if (player) await client.query("INSERT INTO players(id,display_name,revision) VALUES ($1,'Player',1) ON CONFLICT(id) DO UPDATE SET revision=players.revision+1", [player]);
        const result = await task(client); await client.query('COMMIT'); return result;
      } catch (error) {
        if (began) await client.query('ROLLBACK').catch(() => {});
        const retry = ['40001','40P01','OC000','OC001','23505'].includes(error.code);
        if (!retry || attempt + 1 >= maxAttempts) {
          if (retry) throw new SaveError('Concurrent update; please retry', 503);
          throw error;
        }
      } finally { client.release(); }
      await delay(Math.min(800, 20 * 2 ** attempt) + Math.floor(Math.random() * 30));
    }
  }
  const one = async (c, sql, args = []) => (await c.query(sql, args)).rows[0];
  async function writeText(c, id, text) {
    let part = 0;
    // Iterating characters preserves surrogate pairs across chunk boundaries.
    let chunk = '';
    for (const char of text) { chunk += char; if (chunk.length >= TEXT_CHUNK_CHARS) { await c.query('INSERT INTO payload_chunks VALUES ($1,$2,$3)', [id, part++, chunk]); chunk = ''; } }
    if (chunk || !part) await c.query('INSERT INTO payload_chunks VALUES ($1,$2,$3)', [id, part++, chunk]);
    return part;
  }
  async function readText(c, id, count) {
    const rows = (await c.query('SELECT part,data FROM payload_chunks WHERE payload_id=$1 ORDER BY part', [id])).rows;
    requireValue(rows.length === count && rows.every((r,i) => r.part === i), 'Stored payload is incomplete', 500);
    return rows.map(r => r.data).join('');
  }
  async function record(c, player, payload) {
    requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'Invalid battle');
    const { battleId, sourceBattleId = null, sourceSequence = null, decisions = [], outcome = null } = payload;
    requireValue(isId(battleId) && Array.isArray(decisions) && decisions.length <= 1000, 'Invalid battle');
    requireValue([null,'victory','defeat','escaped'].includes(outcome), 'Invalid outcome');
    let battle = await one(c, 'SELECT * FROM battles WHERE id=$1', [battleId]);
    if (battle) {
      requireValue(battle.player_id === player, 'Unknown battle');
      requireValue(battle.source_battle_id === sourceBattleId && battle.source_sequence === sourceSequence, 'Conflicting battle source');
    } else {
      if (sourceBattleId !== null) {
        requireValue(isId(sourceBattleId), 'Invalid source battle');
        const source = await one(c, 'SELECT last_sequence FROM battles WHERE id=$1 AND player_id=$2', [sourceBattleId, player]);
        requireValue(source && Number.isSafeInteger(sourceSequence) && sourceSequence >= 0 && sourceSequence <= source.last_sequence, 'Invalid source checkpoint');
      } else requireValue(sourceSequence === null, 'Invalid source checkpoint');
      await c.query('INSERT INTO battles(id,player_id,source_battle_id,source_sequence,started_at) VALUES ($1,$2,$3,$4,$5)', [battleId, player, sourceBattleId, sourceSequence, stamp()]);
      battle = await one(c, 'SELECT * FROM battles WHERE id=$1', [battleId]);
    }
    let last = battle.last_sequence;
    for (const d of decisions) {
      requireValue(d && isId(d.id) && isId(d.actorId) && isId(d.actionType) && Number.isSafeInteger(d.sequenceNumber) && d.sequenceNumber > 0 && Number.isSafeInteger(d.turnNumber) && d.turnNumber > 0 && Array.isArray(d.targets), 'Invalid decision');
      const targets = JSON.stringify(d.targets), result = JSON.stringify(d.result || {});
      requireValue(Buffer.byteLength(targets) < 900000, 'Too many targets');
      const old = await one(c, 'SELECT * FROM combat_decisions WHERE id=$1 OR (battle_id=$2 AND sequence_number=$3)', [d.id, battleId, d.sequenceNumber]);
      if (old) {
        requireValue(old.id === d.id && old.battle_id === battleId && old.sequence_number === d.sequenceNumber && old.turn_number === d.turnNumber && old.actor_id === d.actorId && old.action_type === d.actionType && old.ability_or_item_id === (d.abilityOrItemId || null) && old.targets_json === targets && await readText(c, 'decision:' + d.id, old.result_parts) === result, 'Conflicting decision retry');
      } else {
        requireValue(!battle.outcome && d.sequenceNumber === last + 1, 'Out-of-order decision');
        const parts = await writeText(c, 'decision:' + d.id, result);
        await c.query('INSERT INTO combat_decisions(id,battle_id,sequence_number,turn_number,actor_id,action_type,ability_or_item_id,targets_json,result_parts,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [d.id,battleId,d.sequenceNumber,d.turnNumber,d.actorId,d.actionType,d.abilityOrItemId||null,targets,parts,stamp()]); last = d.sequenceNumber;
      }
    }
    if (outcome) requireValue(!battle.outcome || battle.outcome === outcome, 'Battle already completed');
    await c.query('UPDATE battles SET last_sequence=$1,outcome=$2,ended_at=$3 WHERE id=$4', [last, outcome || battle.outcome, battle.ended_at || (outcome ? stamp() : null), battleId]);
    return { ...battle, outcome: outcome || battle.outcome, lastSequence: last };
  }
  async function save(c, player, slot, payload, opening) {
    requireValue(Number.isInteger(slot) && slot >= 1 && slot <= (opening ? 6 : 5) && (!opening || slot === 6), 'Slot 6 is reserved for the opening autosave');
    requireValue(payload && typeof payload === 'object', 'Invalid checkpoint'); validateState(payload.state, payload.inventory);
    requireValue(payload.state.battleId === payload.battleId && !payload.outcome, 'Invalid checkpoint battle');
    const battle = await record(c, player, payload);
    requireValue(!battle.outcome && payload.state.sequence === battle.lastSequence, 'Checkpoint does not match battle history');
    const state = JSON.stringify(payload.state);
    if (opening && battle.opening_saved) {
      const old = await one(c, 'SELECT * FROM saves WHERE player_id=$1 AND slot=6 AND battle_id=$2', [player, payload.battleId]);
      requireValue(old && await readText(c, old.id, old.state_parts) === state, 'Opening autosave already replaced'); return;
    }
    if (opening) requireValue(!battle.source_battle_id && !battle.opening_saved && battle.lastSequence === 0 && payload.state.turn === 1, 'Opening autosave already made or not an opening checkpoint');
    const old = await one(c, 'SELECT id FROM saves WHERE player_id=$1 AND slot=$2', [player, slot]);
    if (old) await c.query('INSERT INTO retired_payloads VALUES ($1,$2,$3)', [old.id,player,stamp()]);
    const id = randomUUID(), parts = await writeText(c, id, state);
    const summary = JSON.stringify({turn:payload.state.turn,actor:payload.state.party[payload.state.flags.currentActorIdx].name,party:payload.state.party.map(p=>p.name)});
    await c.query('INSERT INTO saves(player_id,slot,id,battle_id,state_parts,summary_json,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(player_id,slot) DO UPDATE SET id=excluded.id,battle_id=excluded.battle_id,state_parts=excluded.state_parts,summary_json=excluded.summary_json,updated_at=excluded.updated_at', [player,slot,id,payload.battleId,parts,summary,stamp()]);
    await c.query('DELETE FROM inventory WHERE player_id=$1 AND slot=$2', [player,slot]);
    for (const i of payload.inventory) await c.query('INSERT INTO inventory VALUES ($1,$2,$3,$4)', [player,slot,i.item_id,i.quantity]);
    if (opening) await c.query('UPDATE battles SET opening_saved=TRUE WHERE id=$1', [payload.battleId]);
  }
  async function dispatch(c, player, path, payload) {
    if (path === '/api/battles/events') return record(c, player, payload);
    if (path === '/api/autosave') return save(c, player, 6, payload, true);
    const match = /^\/api\/saves\/([1-6])$/.exec(path);
    requireValue(match, 'Unknown endpoint', 404); return save(c, player, Number(match[1]), payload, false);
  }
  async function cleanup(c, player) {
    const cutoff = new Date(Date.now()-3600000).toISOString();
    for (const table of ['request_chunks','response_chunks']) {
      const id = table === 'request_chunks' ? 'upload_id' : 'response_id';
      const rows = (await c.query(`SELECT ${id},part FROM ${table} WHERE player_id=$1 AND created_at<$2 LIMIT 4`, [player,cutoff])).rows;
      for (const row of rows) await c.query(`DELETE FROM ${table} WHERE player_id=$1 AND ${id}=$2 AND part=$3`, [player,row[id],row.part]);
    }
  }
  async function maintenance(player) { return transaction(async c=>{
    await cleanup(c,player);
    const old=await one(c,'SELECT payload_id FROM retired_payloads WHERE player_id=$1 LIMIT 1',[player]);
    if(old){const rows=(await c.query('SELECT part FROM payload_chunks WHERE payload_id=$1 LIMIT 4',[old.payload_id])).rows;for(const row of rows)await c.query('DELETE FROM payload_chunks WHERE payload_id=$1 AND part=$2',[old.payload_id,row.part]);if(rows.length<4)await c.query('DELETE FROM retired_payloads WHERE payload_id=$1',[old.payload_id]);}
  },player); }
  return {
    database, transaction, maintenance,
    close: () => database.close(),
    list: player => transaction(async c => (await c.query('SELECT slot,updated_at,summary_json FROM saves WHERE player_id=$1 ORDER BY slot',[player])).rows.map(r=>({slot:r.slot,updatedAt:r.updated_at,...JSON.parse(r.summary_json)}))),
    load: (player,slot) => transaction(async c => {
      const row = await one(c,'SELECT * FROM saves WHERE player_id=$1 AND slot=$2',[player,slot]); if(!row)return null;
      return {slot,state:JSON.parse(await readText(c,row.id,row.state_parts)),inventory:(await c.query('SELECT item_id,quantity FROM inventory WHERE player_id=$1 AND slot=$2 ORDER BY item_id',[player,slot])).rows,updatedAt:row.updated_at};
    }),
    events: (player,payload) => transaction(c=>record(c,player,payload),player),
    save: (player,slot,payload,opening=false) => transaction(c=>save(c,player,slot,payload,opening),player),
    write: (player,path,payload) => transaction(c=>dispatch(c,player,path,payload),player),
    history: player => transaction(async c => {
      const battles=(await c.query('SELECT * FROM battles WHERE player_id=$1 ORDER BY started_at DESC,id DESC LIMIT 100',[player])).rows;
      if (!battles.length) return battles;
      // Fetch history in batches: a remote SQL round-trip per decision would
      // make long battles exceed the browser/Lambda request deadline.
      const ids = battles.map(b => b.id);
      const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
      const decisions = (await c.query(`SELECT * FROM combat_decisions WHERE battle_id IN (${placeholders}) ORDER BY sequence_number`, ids)).rows;
      const chunks = (await c.query(`SELECT p.payload_id,p.part,p.data FROM payload_chunks p JOIN combat_decisions d ON p.payload_id=('decision:' || d.id) WHERE d.battle_id IN (${placeholders}) ORDER BY p.payload_id,p.part`, ids)).rows;
      const texts = new Map(), grouped = new Map();
      for (const chunk of chunks) {
        if (!texts.has(chunk.payload_id)) texts.set(chunk.payload_id, []);
        const parts = texts.get(chunk.payload_id);
        requireValue(chunk.part === parts.length, 'Stored payload is incomplete', 500);
        parts.push(chunk.data);
      }
      for (const d of decisions) {
        const parts = texts.get('decision:' + d.id) || [];
        requireValue(parts.length === d.result_parts, 'Stored payload is incomplete', 500);
        d.result_json = parts.join(''); delete d.result_parts;
        if (!grouped.has(d.battle_id)) grouped.set(d.battle_id, []);
        grouped.get(d.battle_id).push(d);
      }
      for (const b of battles) b.decisions = grouped.get(b.id) || [];
      return battles;
    }),
    stageUpload: (player,part) => transaction(async c => {
      await cleanup(c,player);
      requireValue(part && /^[a-f0-9-]{36}$/.test(part.id) && Number.isInteger(part.index) && Number.isInteger(part.total) && part.total>0 && part.total<=2048 && part.index>=0 && part.index<part.total && typeof part.data==='string' && part.data.length<=262144 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data), 'Invalid upload chunk');
      requireValue((part.method==='POST' && ['/api/autosave','/api/battles/events'].includes(part.path)) || (part.method==='PUT' && /^\/api\/saves\/[1-6]$/.test(part.path)), 'Invalid upload destination');
      let head=await one(c,'SELECT * FROM request_chunks WHERE player_id=$1 AND upload_id=$2 AND part=-1',[player,part.id]);
      if(!head){const active=await one(c,'SELECT COUNT(*) AS n FROM request_chunks WHERE player_id=$1 AND part=-1 AND completed=FALSE',[player]);requireValue(Number(active.n)<4,'Too many pending uploads',429);await c.query('INSERT INTO request_chunks VALUES ($1,$2,-1,$3,$4,$5,\'\',FALSE,$6)',[player,part.id,part.total,part.method,part.path,new Date().toISOString()]);head={part_count:part.total,method:part.method,path:part.path};}
      requireValue(head.part_count===part.total&&head.method===part.method&&head.path===part.path,'Conflicting upload');
      const old=await one(c,'SELECT data FROM request_chunks WHERE player_id=$1 AND upload_id=$2 AND part=$3',[player,part.id,part.index]);
      if(old)requireValue(old.data===part.data,'Conflicting upload retry');else{requireValue(!head.completed,'Upload already completed');await c.query('INSERT INTO request_chunks VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8)',[player,part.id,part.index,part.total,part.method,part.path,part.data,new Date().toISOString()]);}
    },player),
    commitUpload: (player,id) => transaction(async c => {
      const head=await one(c,'SELECT * FROM request_chunks WHERE player_id=$1 AND upload_id=$2 AND part=-1',[player,id]);requireValue(head,'Unknown upload',404);if(head.completed)return;
      requireValue(Date.parse(head.created_at)>Date.now()-3600000,'Upload expired');
      const rows=(await c.query('SELECT part,data FROM request_chunks WHERE player_id=$1 AND upload_id=$2 AND part>=0 ORDER BY part',[player,id])).rows;
      requireValue(rows.length===head.part_count&&rows.every((r,i)=>r.part===i),'Upload incomplete');const bytes=Buffer.concat(rows.map(r=>Buffer.from(r.data,'base64')));requireValue(bytes.length<=MAX_WRITE_BYTES,'Save too large',413);
      let payload;try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw new SaveError('Invalid request data');}
      await dispatch(c,player,head.path,payload);await c.query('UPDATE request_chunks SET completed=TRUE WHERE player_id=$1 AND upload_id=$2 AND part=-1',[player,id]);
    },player),
    async stageResponse(player,bytes){
      const id=randomUUID(),parts=Math.ceil(bytes.length/TRANSPORT_PART_BYTES);requireValue(parts<=2048,'History response too large; export or archive older history',413);
      // Separate bounded transactions keep response staging below DSQL's 10 MiB limit.
      for(let first=0;first<parts;first+=8)await transaction(async c=>{await cleanup(c,player);for(let i=first;i<Math.min(first+8,parts);i++)await c.query('INSERT INTO response_chunks VALUES ($1,$2,$3,$4,$5)',[player,id,i,bytes.subarray(i*TRANSPORT_PART_BYTES,(i+1)*TRANSPORT_PART_BYTES).toString('base64'),new Date().toISOString()]);},player);
      return {__rpgChunked:{id,parts}};
    },
    responsePart: (player,id,part) => transaction(async c=>{const row=await one(c,'SELECT data,created_at FROM response_chunks WHERE player_id=$1 AND response_id=$2 AND part=$3',[player,id,part]);requireValue(row&&Date.parse(row.created_at)>Date.now()-3600000,'Unknown response chunk',404);return {data:row.data};})
  };
}
