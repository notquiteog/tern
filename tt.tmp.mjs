import pg from 'pg'; import crypto from 'node:crypto';
const db=new pg.Pool({connectionString:'postgres://tern:tern@127.0.0.1:5480/tern'});
const sid=crypto.randomUUID();
await db.query(`INSERT INTO sessions (id,user_id,expires_at,user_agent) VALUES ($1,1,now()+interval '1 hour','verify')`,[sid]);
const H={'X-Requested-With':'tern','Content-Type':'application/json',Cookie:`tern_sid=${sid}`,Accept:'application/json'};
// Thinking ON for the whole install, on a model that can think, through the tap.
await fetch('http://127.0.0.1:42065/api/ai/settings',{method:'PUT',headers:H,body:JSON.stringify({baseUrl:'http://127.0.0.1:11498',model:'qwen3.5:4b',allowThinking:true,thinkEffort:'low'})});
await db.query('DELETE FROM thread_summaries');
const t=await (await fetch('http://127.0.0.1:42065/api/mail/threads?box=burner&accounts=all&page=1',{headers:H})).json();
await (await fetch('http://127.0.0.1:42065/api/ai/summaries',{method:'POST',headers:H,body:JSON.stringify({keys:t.threads.map(x=>x.key),generate:true})})).json();
console.log('summary requests done');
// A normal draft, for contrast: that one is allowed to think.
const r=await fetch('http://127.0.0.1:42065/api/ai/draft',{method:'POST',headers:{...H,Accept:'text/event-stream'},body:JSON.stringify({mode:'compose',instruction:'Say hello briefly',length:'short'})});
await r.text();
console.log('draft request done');
await fetch('http://127.0.0.1:42065/api/ai/settings',{method:'PUT',headers:H,body:JSON.stringify({baseUrl:'http://127.0.0.1:11435',allowThinking:false})});
await db.query(`DELETE FROM sessions WHERE user_agent='verify'`); await db.end();
