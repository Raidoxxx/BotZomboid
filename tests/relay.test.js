import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, rename, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { MARKER, webhookURL, parseLine, payload, Relay, loadState, atomicState } from '../src/relay.js';

// Non-secret test fixture; requests always use injected fetch, never this remote URL.
const URL_TEST=`https://discord.com/api/webhooks/${'1'.repeat(18)}/${'x'.repeat(24)}`;
const MESSAGE='222222222222222222';
const BASE=1793710000000;
const event=(id='test:1',kind='test',priority=3,data={})=>({v:1,id,kind,priority,at:BASE,cooldown:600000,maxPerMinute:6,data});
const response=(status=200,body={id:MESSAGE},headers={})=>new Response(JSON.stringify(body),{status,headers});
function fixture(responses=[]) {
  const state={version:1,queue:[],seen:{},cooldowns:{},sent:[],nextRequest:0,disabledUntil:0};
  let now=BASE; const requests=[], logs=[];
  const relay=new Relay({url:URL_TEST,state,clock:()=>now,log:s=>logs.push(s),fetchFn:async(url,init)=>{
    requests.push({url:String(url),...init}); const next=responses.shift(); if(next instanceof Error) throw next;
    return next || response();
  }});
  return {relay,state,requests,logs,advance:ms=>{now+=ms;},now:()=>now};
}
async function temp() {
  return mkdtemp(join(tmpdir(),'botzomboid-'));
}

test('private webhook validation only permits HTTPS Discord webhook paths',()=>{
  assert.equal(webhookURL(URL_TEST).hostname,'discord.com');
  for(const value of ['not a url',URL_TEST.replace('https:','http:'),URL_TEST.replace('discord.com','example.com'),URL_TEST+'#x',URL_TEST.replace('/api/','/proxy/')]) {
    assert.throws(()=>webhookURL(value),/^Error: Invalid private DiscordWebhookURL$/);
  }
});
test('dedicated journal parser rejects prefixed chat logs and malformed records',()=>{
  assert.equal(parseLine(MARKER+JSON.stringify(event())).kind,'test');
  assert.equal(parseLine('chat: '+MARKER+JSON.stringify(event())),null);
  assert.equal(parseLine(MARKER+'{}'),null); assert.equal(parseLine('normal log'),null);
  assert.equal(parseLine(MARKER+JSON.stringify({...event(),at:null})),null);
  assert.equal(parseLine(MARKER+JSON.stringify(event('id','test',3,{players:{}}))),null);
});
test('embeds disable mentions on all methods and bound user text',()=>{
  const p=payload([event('id','nearby',3,{herd:'h',count:400,level:3,region:'x'.repeat(6000),players:[{name:'@everyone <@123>',distance:70}]})],'server');
  assert.deepEqual(p.allowed_mentions.parse,[]); assert.equal(p.embeds[0].color,0xe74c3c);
  assert.ok(p.embeds[0].fields.every(f=>f.value.length<=1024)); assert.ok(JSON.stringify(p).length<7000);
});
test('successful delivery requires confirmed HTTP message id and wait=true',async()=>{
  const f=fixture(); f.relay.ingest(event()); assert.equal(await f.relay.pump(),true);
  assert.match(f.requests[0].url,/wait=true/); assert.equal(f.requests[0].method,'POST');
  assert.equal(f.requests[0].redirect,'error'); assert.ok(f.state.seen['test:1']);
  assert.match(f.logs[0],/HTTP 200; message confirmed/);
});
test('empty successful HTTP body never claims delivery',async()=>{
  const f=fixture([response(200,{})]); f.relay.ingest(event()); assert.equal(await f.relay.pump(),false);
  assert.ok(!f.logs.some(s=>s.includes('message confirmed'))); assert.match(f.logs[0],/unconfirmed/);
});
test('invalid or forbidden webhook is suspended without exposing credentials',async()=>{
  for(const code of [401,403,404]) {
    const f=fixture([response(code,{message:URL_TEST})]); f.relay.ingest(event());
    assert.equal(await f.relay.pump(),false); assert.equal(f.state.disabledUntil,BASE+900000);
    f.advance(10000); await f.relay.pump(); assert.equal(f.requests.length,1);
    assert.ok(!f.logs.join('').includes(URL_TEST));
  }
});
test('temporary Discord failures use asynchronous backoff and bounded attempts',async()=>{
  const f=fixture([response(503),new Error('sensitive '+URL_TEST),response()]); f.relay.ingest(event());
  await f.relay.pump(); assert.equal(f.state.queue[0].attempt,1); assert.ok(f.state.queue[0].nextAt>=BASE+2000);
  await f.relay.pump(); assert.equal(f.requests.length,1);
  f.advance(3000); await f.relay.pump(); assert.equal(f.requests.length,2);
  f.advance(6000); assert.equal(await f.relay.pump(),true); assert.ok(!f.logs.join('').includes(URL_TEST));
});
test('HTTP 429 honors fractional Retry-After header and body, including global wait',async()=>{
  const f=fixture([response(429,{retry_after:3.5,global:true},{'retry-after':'2.5'}),response()]);
  f.relay.ingest(event()); await f.relay.pump(); assert.equal(f.state.nextRequest,BASE+3750);
  f.advance(3000); await f.relay.pump(); assert.equal(f.requests.length,1);
  f.advance(1000); assert.equal(await f.relay.pump(),true);
});
test('HTTP 429 Retry-After HTTP date and remaining/reset-after are respected',async()=>{
  const f=fixture([response(429,{}, {'retry-after':new Date(BASE+5000).toUTCString()}),response(200,{id:MESSAGE},{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'4.25'})]);
  f.relay.ingest(event()); await f.relay.pump(); assert.equal(f.state.nextRequest,BASE+5250);
  f.advance(6000); await f.relay.pump(); assert.equal(f.state.nextRequest,BASE+10500);
});
test('rolling per-minute cap counts retries as requests',async()=>{
  const f=fixture();
  for(let i=0;i<7;i++) f.relay.ingest(event('e'+i,'test',3,{herd:'h'+i}));
  for(let i=0;i<7;i++) { await f.relay.pump(); f.advance(1100); }
  assert.equal(f.requests.length,6); f.advance(61000); await f.relay.pump(); assert.equal(f.requests.length,7);
});
test('critical alerts precede reports; informational queue cannot evict critical',async()=>{
  const f=fixture(); f.relay.ingest(event('r','report',1,{herds:0,players:[]}));
  f.relay.ingest(event('critical','nearby',3,{herd:'h',players:[{name:'a',level:3,distance:70}],level:3}));
  await f.relay.pump(); assert.match(f.requests[0].body,/JOGADOR/);
  for(let i=0;i<200;i++) f.relay.ingest(event('q'+i,'created',1,{herd:'h'+i}));
  assert.equal(f.state.queue.length,128);
});
test('two survivors near one herd are consolidated; late arrivals remain eligible',async()=>{
  const f=fixture();
  f.relay.ingest(event('a','nearby',3,{herd:'h',level:3,players:[{name:'a',level:3,distance:50}]}));
  f.relay.ingest(event('b','nearby',3,{herd:'h',level:3,players:[{name:'b',level:3,distance:60}]}));
  assert.equal(f.state.queue.length,1); assert.equal(f.state.queue[0].event.data.players.length,2);
  await f.relay.pump(); f.advance(2000);
  assert.equal(f.relay.ingest(event('c','nearby',3,{herd:'h',level:3,players:[{name:'c',level:3,distance:80}]})),true);
  assert.equal(f.relay.ingest(event('repeat','nearby',3,{herd:'h',level:3,players:[{name:'a',level:3,distance:50}]})),false);
});
test('persistent status uses POST wait=true then PATCH, including allowed_mentions',async()=>{
  const f=fixture(); f.relay.ingest(event('r1','report',1,{herds:1,accounted:20,physical:10,unconfirmed:10,players:[]}));
  f.advance(3000); assert.equal(await f.relay.pump(),true); assert.equal(f.state.messageID,MESSAGE);
  f.advance(1800000); f.relay.ingest({...event('r2','report',1,{herds:2,players:[]}),at:f.now()}); f.advance(3000);
  assert.equal(await f.relay.pump(),true); assert.equal(f.requests[1].method,'PATCH');
  assert.ok(f.requests[1].url.includes('/messages/'+MESSAGE));
  assert.deepEqual(JSON.parse(f.requests[1].body).allowed_mentions.parse,[]);
});
test('deleted report is recreated, not treated as an invalid webhook',async()=>{
  const f=fixture([response(404),response()]); f.state.messageID=MESSAGE;
  f.relay.ingest(event('r','report',1,{})); f.advance(3000); await f.relay.pump(); assert.equal(f.state.messageID,null);
  assert.equal(f.state.disabledUntil,0); f.advance(1500); assert.equal(await f.relay.pump(),true);
  assert.equal(f.requests[1].method,'POST');
});
test('persistent state restores pending retries, dedup and status id on restart',async()=>{
  const path=join(await temp(),'private-state.json'); const f=fixture();
  f.relay.ingest(event('sent')); await f.relay.pump(); f.state.messageID=MESSAGE;
  f.relay.ingest(event('pending','created',1,{herd:'h'})); await atomicState(path,f.state);
  const restored=await loadState(path); const requests=[];
  const relay=new Relay({url:URL_TEST,state:restored,clock:f.now,log:()=>{},fetchFn:async(...args)=>{requests.push(args); return response();}});
  assert.equal(relay.ingest(event('sent')),false); assert.equal(restored.messageID,MESSAGE); assert.equal(restored.queue.length,1);
});
test('corrupt relay state fails closed instead of replaying an entire log',async()=>{
  const path=join(await temp(),'state.json'); await writeFile(path,'{"version":99}');
  await assert.rejects(loadState(path),/Private relay state invalid/);
});
test('actual local HTTP POST/PATCH transport confirms response without contacting Discord',async()=>{
  const received=[];
  const server=createServer(async(req,res)=>{
    let body=''; for await(const chunk of req) body+=chunk;
    received.push({method:req.method,url:req.url,body:JSON.parse(body)});
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({id:MESSAGE}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const f=fixture();
    f.relay.fetch=(url,init)=>fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,init);
    f.relay.ingest(event('one','report',3,{})); await f.relay.pump();
    f.advance(2000); f.relay.ingest({...event('two','report',3,{}),at:f.now()}); await f.relay.pump();
    assert.deepEqual(received.map(r=>r.method),['POST','PATCH']); assert.match(received[0].url,/wait=true/);
    assert.deepEqual(received[1].body.allowed_mentions.parse,[]);
  } finally { await new Promise(r=>server.close(r)); }
});
test('six failed requests drop the event without a false retry/success log',async()=>{
  const f=fixture(Array.from({length:6},()=>response(503))); f.relay.ingest(event());
  for(let i=0;i<6;i++) { await f.relay.pump(); f.advance(70000); }
  assert.equal(f.requests.length,6); assert.equal(f.state.queue.length,0);
  assert.match(f.logs.at(-1),/event dropped after six attempts/); assert.ok(!f.logs.some(s=>s.includes('message confirmed')));
});
test('rate-limit delays start at response receipt, not at request start',async()=>{
  const f=fixture(); f.relay.fetch=async()=>{ f.advance(10000); return response(429,{retry_after:5}); };
  f.relay.ingest(event()); await f.relay.pump(); assert.equal(f.state.nextRequest,BASE+15250);
});
test('startup embed identifies actual initialization without claiming herd movement',()=>{
  const e=event('boot-a','startup',1,{session:'boot-a',gameVersion:'42.21',startedAt:BASE,systemEnabled:true,
    description:'O gerenciador Living Herds foi inicializado neste processo do servidor.'});
  assert.ok(parseLine(MARKER+JSON.stringify(e)));
  assert.equal(parseLine(MARKER+JSON.stringify(event('bad','startup',1,{}))),null);
  const body=payload([e],'Servidor de teste');
  assert.match(body.embeds[0].title,/MOD INICIADO/); assert.equal(body.embeds[0].color,0x2ecc71);
  assert.ok(body.embeds[0].fields.some(f=>f.name==='Versão do jogo' && f.value==='42.21'));
  assert.deepEqual(body.allowed_mentions.parse,[]);
});
test('a new boot is notified within normal cooldown; replay of the same boot is deduplicated',async()=>{
  const f=fixture(); const first=event('boot-one','startup',1,{session:'one'});
  f.relay.ingest(first); f.advance(3000); assert.equal(await f.relay.pump(),true);
  assert.equal(f.relay.ingest(first),false);
  f.advance(10000); assert.equal(f.relay.ingest({...event('boot-two','startup',1,{session:'two'}),at:f.now()}),true);
  f.advance(3000); assert.equal(await f.relay.pump(),true);
  assert.equal(f.requests.length,2); assert.ok(f.requests.every(r=>r.method==='POST'));
});
