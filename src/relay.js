import { createHash } from 'node:crypto';
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MARKER = '[LivingHerdsDiscord] ';
const KINDS = new Set(['startup','created','merged','split','migration','mega','base','dispersed','destroyed','nearby','approaching','report','test']);
const TITLES = {
  startup:'🟢 MOD INICIADO',
  created:'🟢 HORDA CRIADA', merged:'🟢 HORDAS FUNDIDAS', split:'🟢 HORDA DIVIDIDA',
  migration:'🟢 MIGRAÇÃO INICIADA', mega:'🟠 MEGAHORDA DETECTADA', base:'🟠 HORDA PRÓXIMA DE BASE',
  dispersed:'🟢 HORDA DISPERSADA', destroyed:'🟢 HORDA ELIMINADA', nearby:'⚠️ JOGADOR PRÓXIMO DE UMA HORDA',
  approaching:'🚨 HORDA SE APROXIMANDO', report:'📊 RELATÓRIO GLOBAL', test:'🔧 TESTE ADMINISTRATIVO',
};
const text = (s, max=1024) => String(s ?? '').replace(/[\u0000-\u001f]/g,' ').replace(/([`*_~|<>\\])/g,'\\$1').slice(0,max);
const number = n => Number.isFinite(n) && n >= 0;
const finiteInt = (n, min, max, fallback) => Number.isFinite(Number(n)) ? Math.min(max,Math.max(min,Math.floor(Number(n)))) : fallback;
const cooldownKey = e => `herd:${e.kind}:${e.kind==='startup' ? e.data.session : e.data.herd || 'world'}:${e.priority}`;

export function webhookURL(raw) {
  let url;
  try { url=new URL(raw); } catch { throw new Error('Invalid private DiscordWebhookURL'); }
  if (url.protocol!=='https:' || !['discord.com','canary.discord.com','ptb.discord.com','discordapp.com'].includes(url.hostname) ||
      url.username || url.password || url.port || url.hash || !/^\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{20,}$/.test(url.pathname)) {
    throw new Error('Invalid private DiscordWebhookURL');
  }
  const thread=url.searchParams.get('thread_id');
  url.search='';
  if (thread && /^\d{17,20}$/.test(thread)) url.searchParams.set('thread_id',thread);
  return url;
}

export function parseLine(line) {
  const start=line.indexOf(MARKER);
  if (start!==0 || Buffer.byteLength(line)>16384) return null;
  try {
    const event=JSON.parse(line.slice(start+MARKER.length).trim());
    if (event.v!==1 || typeof event.id!=='string' || event.id.length>160 || !KINDS.has(event.kind) ||
        !number(event.at) || !event.data || typeof event.data!=='object' || Array.isArray(event.data)) return null;
    event.priority=finiteInt(event.priority,1,3,1);
    event.cooldown=finiteInt(event.cooldown,60000,86400000,600000);
    event.maxPerMinute=finiteInt(event.maxPerMinute,1,30,6);
    if (event.kind==='startup' && (typeof event.data.session!=='string' || event.data.session.length>120 || !event.data.session)) return null;
    if (event.data.players && (!Array.isArray(event.data.players) || event.data.players.length>32)) return null;
    return event;
  } catch { return null; }
}

export function payload(events,serverName) {
  const first=events[0], d=first.data;
  const fields=[];
  const field=(name,value) => { if (value!==undefined && value!==null && fields.length<25) fields.push({name,value:text(value),inline:true}); };
  const players=events.flatMap(e=>Array.isArray(e.data.players) ? e.data.players : []);
  if (first.kind==='startup') {
    field('Versão do jogo',d.gameVersion);
    field('Gerenciamento de hordas',d.systemEnabled ? 'Ativo' : 'Pausado no Sandbox');
    if (number(d.startedAt) && d.startedAt<=8640000000000000) field('Gerenciador inicializado em',new Date(d.startedAt).toISOString());
  } else if (first.kind==='report') {
    field('Hordas',d.herds); field('Walkers contabilizados',d.accounted);
    field('Físicos observados (subconjunto)',d.physical); field('Vínculos não confirmados',d.unconfirmed);
    field('Maior horda',d.largest); field('Hordas próximas',d.nearHerds);
    field('Estados',Object.entries(d.states || {}).map(([s,n])=>`${s}: ${n}`).join(' | ') || 'Nenhuma horda');
    field('Jogadores conectados',d.connected ?? players.length);
  } else {
    field('Horda',d.herd); field('Walkers estimados',d.count); field('Estado',d.state);
    field('Região',d.region); field('Posição',d.positionKind);
    field('Distância aproximada (tiles)',d.distance); field('Direção observada',d.direction);
    field('Velocidade observada (tiles/s reais)',d.speed);
    field('Outra horda',d.other); field('Nova horda',d.child); field('Base cadastrada',d.base); field('Motivo',d.reason);
    if (d.level) field('Nível',['','ATENÇÃO','PERIGO','CRÍTICO'][d.level]);
  }
  if (players.length) {
    const rows=players.slice(0,32).map(p=>`${text(p.name,80)} — ${number(p.distance) ? `${Math.floor(p.distance)} tiles${p.estimated ? ' (projeção)' : ''}` : 'nenhuma horda próxima'}${p.herd ? ` — ${text(p.herd,100)}` : ''}`);
    // Embed totals remain below Discord's 6000 character aggregate limit.
    for(let i=0;i<rows.length && fields.length<22;i+=8) fields.push({name:i===0?'Sobreviventes':'Sobreviventes (continuação)',value:rows.slice(i,i+8).join('\n').slice(0,1000),inline:false});
  }
  if (events.length>1 && first.kind!=='nearby') field('Eventos consolidados',events.length);
  const color=first.priority>=3 ? 0xe74c3c : first.kind==='approaching' || first.kind==='nearby' && first.priority===1 ? 0xf1c40f : first.priority===2 ? 0xe67e22 : first.kind==='report' ? 0x3498db : 0x2ecc71;
  const embed={title:`LIVING HERDS — ${TITLES[first.kind]}`.slice(0,256),color,
    description:text(d.description || (first.kind==='report' ? 'Físicos são parte do total, nunca população adicional. Vínculos não confirmados não comprovam presença virtual.' : 'Evento registrado pelo gerenciador do servidor.'),1000),
    fields, timestamp:new Date(first.at).toISOString(),footer:{text:text(serverName,200)}};
  // Hard budget, including user-controlled names and native zone labels.
  let budget=5500-embed.title.length-embed.description.length-embed.footer.text.length;
  embed.fields=fields.filter(f=>{ budget-=f.name.length+f.value.length; return budget>=0; });
  return {allowed_mentions:{parse:[],users:[],roles:[],replied_user:false},embeds:[embed]};
}

export async function atomicState(path,state) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.${process.pid}.tmp`;
  const file=await open(temp,'w',0o600);
  try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
  await rename(temp,path);
}

export async function loadState(path) {
  try {
    const content=await readFile(path,'utf8');
    if (content.length>4*1024*1024) throw new Error('oversized state');
    const state=JSON.parse(content);
    if (state.version!==1 || !Array.isArray(state.queue) || state.queue.length>128 || typeof state.seen!=='object' || !state.seen || typeof state.cooldowns!=='object' || !state.cooldowns) throw new Error('invalid state');
    for (const item of state.queue) if (!parseLine(MARKER+JSON.stringify(item.event)) || !number(item.nextAt) || !number(item.attempt)) throw new Error('invalid pending event');
    return state;
  } catch (error) {
    if (error.code==='ENOENT') return {version:1,queue:[],seen:{},cooldowns:{},sent:[],messageID:null,nextRequest:0,disabledUntil:0};
    throw new Error('Private relay state invalid; restore or inspect backup (contents suppressed)');
  }
}

export class Relay {
  constructor({url,state,clock=Date.now,fetchFn=fetch,log=console.log,serverName='Living Herds',maxPerMinute=6}) {
    this.url=webhookURL(url); this.state=state; this.clock=clock; this.fetch=fetchFn; this.log=log;
    this.serverName=serverName; this.maxPerMinute=finiteInt(maxPerMinute,1,30,6); this.busy=false;
    const fingerprint=createHash('sha256').update(this.url.toString()).digest('hex');
    if (state.webhookFingerprint && state.webhookFingerprint!==fingerprint) { state.messageID=null; state.disabledUntil=0; state.nextRequest=0; }
    state.webhookFingerprint=fingerprint;
  }
  ingest(event) {
    const now=this.clock(), s=this.state;
    if (!event || event.at<now-1800000 || event.at>now+300000 || s.seen[event.id] || s.queue.some(i=>i.event.id===event.id)) return false;
    if (event.kind==='report') s.queue=s.queue.filter(i=>i.event.kind!=='report');
    const d=event.data;
    // Incoming players are checked independently: a new survivor is never hidden by a herd's existing alert.
    if (event.kind==='nearby' && Array.isArray(d.players)) {
      d.players=d.players.filter(p=>typeof p.name==='string' && !(s.cooldowns[`player:${p.name}:${p.level}`]>now));
      if (!d.players.length) return false;
    }
    const key=cooldownKey(event);
    if (event.kind!=='nearby' && event.kind!=='report' && s.cooldowns[key]>now) return false;
    const pending=s.queue.find(i=>i.event.kind===event.kind && i.event.data.herd===d.herd && event.kind==='nearby');
    if (pending) {
      for(const p of d.players) {
        const old=pending.event.data.players.find(q=>q.name===p.name);
        if (old) Object.assign(old,p); else if (pending.event.data.players.length<32) pending.event.data.players.push(p);
      }
      pending.event.priority=Math.max(pending.event.priority,event.priority);
      pending.event.data.level=Math.max(pending.event.data.level || 0,d.level || 0);
      s.seen[event.id]=now;
      return true;
    }
    if (s.queue.length>=128) {
      let lowest=0; for(let i=1;i<s.queue.length;i++) if(s.queue[i].event.priority<s.queue[lowest].event.priority) lowest=i;
      if (s.queue[lowest].event.priority>=event.priority) return false;
      s.queue.splice(lowest,1);
    }
    s.queue.push({event,nextAt:now+(event.priority===3?0:2000),attempt:0});
    return true;
  }
  async pump() {
    if (this.busy) return false;
    this.busy=true;
    try { return await this.sendNext(); } finally { this.busy=false; }
  }
  async sendNext() {
    const s=this.state, now=this.clock();
    s.sent=(s.sent || []).filter(t=>t>now-60000);
    for(const [id,at] of Object.entries(s.seen)) if(at<now-3600000) delete s.seen[id];
    const seen=Object.entries(s.seen).sort((a,b)=>b[1]-a[1]);
    for(const [id] of seen.slice(4096)) delete s.seen[id];
    for(const [key,until] of Object.entries(s.cooldowns)) if(until<=now) delete s.cooldowns[key];
    const cooldowns=Object.entries(s.cooldowns).sort((a,b)=>b[1]-a[1]);
    for(const [key] of cooldowns.slice(4096)) delete s.cooldowns[key];
    s.queue=s.queue.filter(i=>i.event.at>=now-1800000);
    if(now<(s.nextRequest || 0) || now<(s.disabledUntil || 0)) return false;
    const ready=s.queue.filter(i=>i.nextAt<=now).sort((a,b)=>b.event.priority-a.event.priority || a.event.at-b.event.at);
    const item=ready[0]; if(!item) return false;
    const e=item.event;
    if (s.sent.length>=Math.min(this.maxPerMinute,e.maxPerMinute)) return false;
    if ((s.cooldowns[`type:${e.kind}`] || 0)>now) return false;
    const editing=e.kind==='report' && /^\d{17,20}$/.test(s.messageID || '');
    const target=new URL(this.url);
    if(editing) target.pathname+=`/messages/${s.messageID}`; else target.searchParams.set('wait','true');
    const body=payload([e],this.serverName);
    s.sent.push(now); // Count every HTTP attempt, including retries and PATCH.
    let response, json;
    try {
      response=await this.fetch(target,{method:editing?'PATCH':'POST',body:JSON.stringify(body),
        headers:{'Content-Type':'application/json','User-Agent':'BotZomboid/0.3.0'},
        signal:AbortSignal.timeout(10000),redirect:'error'});
      // Never log response bodies: they can echo webhook credentials or player names.
      const raw=await response.text();
      if (raw.length<65536) { try { json=JSON.parse(raw); } catch {} }
    } catch {
      const retry=this.retry(item,this.clock());
      this.log(`[BotZomboid] network failure; ${retry?'retry scheduled':'event dropped after six attempts'} (details suppressed)`); return false;
    }
    const received=this.clock();
    const retryHeader=response.headers.get('retry-after');
    const seconds=retryHeader===null ? 0 : Number(retryHeader);
    const headerDelay=Number.isFinite(seconds) ? Math.max(0,seconds*1000) : Math.max(0,Date.parse(retryHeader)-received) || 0;
    const reset=Number(response.headers.get('x-ratelimit-reset-after'));
    if(response.headers.get('x-ratelimit-remaining')==='0' && reset>0) s.nextRequest=received+reset*1000+250;
    if(response.status===429) {
      s.nextRequest=received+Math.max(1000,headerDelay,number(json?.retry_after)?json.retry_after*1000:0)+250;
      item.nextAt=s.nextRequest; this.log('[BotZomboid] HTTP 429; Retry-After applied'); return false;
    }
    if(editing && response.status===404) {
      s.messageID=null; item.nextAt=received+1000; this.log('[BotZomboid] status message missing; recreate scheduled'); return false;
    }
    if([401,403,404].includes(response.status)) {
      s.disabledUntil=received+900000; item.nextAt=s.disabledUntil;
      this.log(`[BotZomboid] HTTP ${response.status}; webhook suspended for 15 minutes`); return false;
    }
    if(response.status>=500 || response.status===408) {
      const retry=this.retry(item,received);
      this.log(`[BotZomboid] HTTP ${response.status}; ${retry?'retry scheduled':'event dropped after six attempts'}`); return false;
    }
    if(response.status<200 || response.status>=300 || !/^\d{17,20}$/.test(json?.id || '')) {
      // wait=true/PATCH must confirm a message ID. Never announce success for an empty/malformed body.
      s.queue=s.queue.filter(i=>i!==item); s.seen[e.id]=now;
      this.log(`[BotZomboid] HTTP ${response.status}; delivery unconfirmed or rejected; event dropped`); return false;
    }
    if(e.kind==='report') s.messageID=json.id;
    s.queue=s.queue.filter(i=>i!==item); s.seen[e.id]=now;
    s.cooldowns[`type:${e.kind}`]=now+1000;
    s.cooldowns[cooldownKey(e)]=now+e.cooldown;
    if(e.kind==='nearby') for(const p of e.data.players || []) s.cooldowns[`player:${p.name}:${p.level}`]=now+e.cooldown;
    this.log(`[BotZomboid] HTTP ${response.status}; ${editing?'message updated':'message confirmed'}; event=${e.kind}`);
    return true;
  }
  retry(item,now) {
    item.attempt++;
    if(item.attempt>=6) { this.state.queue=this.state.queue.filter(i=>i!==item); this.state.seen[item.event.id]=now; return false; }
    item.nextAt=now+Math.min(60000,1000*2**item.attempt)+Math.floor(Math.random()*250); return true;
  }
}
