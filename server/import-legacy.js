// Optional one-time importer. The running game never reads SQLite.
import { randomUUID } from 'node:crypto';
import { createStore, validateState } from './store.js';

export async function importLegacy(database, legacy) {
  const tables=['players','battles','saves','inventory','combat_decisions'];
  for(const table of tables)if(!Array.isArray(legacy[table]))throw Error('Missing legacy table: '+table);
  // A single transaction makes the whole import all-or-nothing. Larger exports
  // need an offline batch migration rather than exceeding DSQL mutation limits.
  if(Buffer.byteLength(JSON.stringify(legacy))>6*1024*1024)throw Error('Legacy export exceeds the 6 MiB atomic import budget; use an offline batch migration');
  let chunks=0;
  for(const row of [...legacy.saves,...legacy.combat_decisions])chunks+=Math.ceil((row.state_json||row.result_json||'{}').length/59999)+1;
  if(tables.reduce((n,t)=>n+legacy[t].length,0)+chunks>2000)throw Error('Legacy export exceeds the atomic row budget; use an offline batch migration');
  for(const save of legacy.saves){
    if(save.schema_version!==2)throw Error('Unsupported legacy save version');
    const state=JSON.parse(save.state_json),inventory=legacy.inventory.filter(i=>i.save_id===save.id);
    validateState(state,inventory);if(state.battleId!==save.battle_id)throw Error('Conflicting legacy save identity');
  }
  for(const d of legacy.combat_decisions){JSON.parse(d.targets_json);JSON.parse(d.result_json);}
  const store=createStore(database);
  await store.transaction(async c=>{
    if(Number((await c.query('SELECT COUNT(*) AS n FROM players')).rows[0].n)!==0)throw Error('Import requires an empty target database; existing players will not be overwritten');
    async function payload(id,text){let part=0,chunk='';for(const char of text){chunk+=char;if(chunk.length>=60000){await c.query('INSERT INTO payload_chunks VALUES ($1,$2,$3)',[id,part++,chunk]);chunk='';}}if(chunk||!part)await c.query('INSERT INTO payload_chunks VALUES ($1,$2,$3)',[id,part++,chunk]);return part;}
    for(const p of legacy.players)await c.query('INSERT INTO players(id,display_name) VALUES ($1,$2)',[p.id,p.display_name]);
    const pending=[...legacy.battles],done=new Set();
    while(pending.length){let progress=false;for(let i=pending.length-1;i>=0;i--){const b=pending[i];if(b.source_battle_id&&!done.has(b.source_battle_id))continue;
      const last=legacy.combat_decisions.filter(d=>d.battle_id===b.id).reduce((n,d)=>Math.max(n,d.sequence_number),0);
      await c.query('INSERT INTO battles(id,player_id,encounter_id,source_battle_id,source_sequence,opening_saved,last_sequence,outcome,started_at,ended_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[b.id,b.player_id,b.encounter_id,b.source_battle_id,b.source_sequence,!!b.opening_saved,last,b.outcome,b.started_at,b.ended_at]);done.add(b.id);pending.splice(i,1);progress=true;
    }if(!progress)throw Error('Legacy history has missing or cyclic source battles');}
    for(const d of legacy.combat_decisions){const parts=await payload('decision:'+d.id,d.result_json);await c.query('INSERT INTO combat_decisions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[d.id,d.battle_id,d.sequence_number,d.turn_number,d.actor_id,d.action_type,d.ability_or_item_id,d.targets_json,parts,d.created_at]);}
    for(const s of legacy.saves){const id=randomUUID(),parts=await payload(id,s.state_json),state=JSON.parse(s.state_json),summary=JSON.stringify({turn:state.turn,actor:state.party[state.flags.currentActorIdx].name,party:state.party.map(p=>p.name)});
      await c.query('INSERT INTO saves VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[s.player_id,s.slot,id,s.battle_id,s.schema_version,parts,summary,s.updated_at]);
      for(const i of legacy.inventory.filter(i=>i.save_id===s.id))await c.query('INSERT INTO inventory VALUES ($1,$2,$3,$4)',[s.player_id,s.slot,i.item_id,i.quantity]);
    }
  });
  return Object.fromEntries(tables.map(t=>[t,legacy[t].length]));
}
