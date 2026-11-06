import https from 'node:https';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { localCertificate } from './server/tls.mjs';
import { b64, un64, mac, equalProof, random, sessionKeys, proofData, seal, open, wrapPair } from './public/crypto.js';

const root=dirname(fileURLToPath(import.meta.url));
const shaToken=()=>createHash('sha512').update(randomBytes(64)).digest('hex');
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
const decode32=s=>{const b=un64(String(s));if(b.length!==32)throw Error('invalid nonce');return b;};
const configPath=pathJoin(root,'config.json');let config;
try { config=JSON.parse(await readFile(configPath,'utf8')); } catch(e) { if(e.code==='ENOENT')config=JSON.parse(await readFile(pathJoin(root,'config.example.json'),'utf8'));else throw e; }
let host;try {host=(await readFile(pathJoin(root,'ip.txt'),'utf8')).trim();}catch{throw Error('ip.txt がありません。ip.example.txt を ip.txt にコピーし、127.0.0.1 を指定してください。');}
if(host!=='127.0.0.1')throw Error('ip.txt は UTF-8 の 127.0.0.1 一行にしてください。外部アドレスへの待受は拒否しました。');
const port=Number(config.port??9443);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid port');
const appUrl=new URL(config.appUrl);if(appUrl.protocol!=='https:'||appUrl.username||appUrl.password||appUrl.hash)throw Error('config.appUrl must be HTTPS');
const allowedOrigins=new Set([appUrl.origin]);for(const o of config.allowedAppOrigins??[]){const u=new URL(o);if(u.protocol!=='https:'||u.origin!==o)throw Error('invalid allowedAppOrigins');allowedOrigins.add(o);}
const iceServers=config.iceServers??[];if(!Array.isArray(iceServers)||iceServers.length>8)throw Error('invalid iceServers');
for(const s of iceServers){for(const u of [s.urls].flat()){if(typeof u!=='string'||!/^(stun|stuns|turn|turns):[^\s]+$/.test(u))throw Error('invalid ICE URL');}}
const token=shaToken(),adminToken=shaToken();
const keys={receiver:{a:random(32),e:random(32)},sender:{a:random(32),e:random(32)}};
const pending=new Map(),clients=new Map();let publicOrigin=null,tunnel=null,closing=false;
const tls=await localCertificate(pathJoin(root,'.runtime'));const adminPort=port+1;if(adminPort>65535)throw Error('port too high');
const localOrigin=`https://127.0.0.1:${adminPort}`;
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Strict-Transport-Security':'max-age=31536000'};
const urlFor=async role=>{if(!publicOrigin)return null;const pair={v:1,u:`${publicOrigin}/${token}`,a:b64(keys[role].a),e:b64(keys[role].e),r:role};const u=new URL(appUrl);u.hash='pair='+await wrapPair(pair);return u.href;};
function json(res,value,cors={}){const body=JSON.stringify(value);res.writeHead(200,{...headers,...cors,'Content-Type':'application/json;charset=utf-8','Content-Length':Buffer.byteLength(body)});res.end(body);}
async function body(req,max=160*1024){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>max)throw Error('request too large');chunks.push(c);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
function expireClient(id){const c=clients.get(id);if(!c)return;clients.delete(id);for(const p of clients.values())p.inbox.push({type:'left',id});}
function boundedPush(c,msg){if(c.inbox.length>=128)throw Error('signaling queue full');c.inbox.push(msg);}
function dispatch(c,p){
  if(!p||typeof p!=='object')throw Error('bad request');
  if(p.type==='poll')return {events:c.inbox.splice(0,64)};
  if(p.type==='leave'){expireClient(c.id);return {ok:true};}
  if(p.type==='signal'){
    const peer=clients.get(p.to);if(!peer||peer.role===c.role)throw Error('peer unavailable');
    const v=p.data;if(!v||!['offer','answer','ice'].includes(v.type)||JSON.stringify(v).length>120000)throw Error('invalid signal');
    boundedPush(peer,{type:'signal',from:c.id,data:v});return {ok:true};
  }
  throw Error('unknown operation');
}
const signalServer=https.createServer({...tls,minVersion:'TLSv1.3'},(req,res)=>{void (async()=>{
  const u=new URL(req.url,'https://localhost');const parts=u.pathname.split('/');
  if(!same(parts[1]??'',token)){req.socket.destroy();return;}
  const origin=req.headers.origin;
  if(!allowedOrigins.has(origin)){req.socket.destroy();return;}
  const cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'content-type','Access-Control-Max-Age':'600'};
  if(req.method==='OPTIONS'){res.writeHead(204,{...headers,...cors});res.end();return;}
  if(req.method!=='POST'||parts.length!==3){req.socket.destroy();return;}
  const p=await body(req);
  if(parts[2]==='hello'){
    if(pending.size>=32||clients.size>=8)throw Error('room full');const role=p.role;if(!keys[role])throw Error('invalid role');
    const cn=decode32(p.cn),sn=random(32),id=b64(random(16));
    const s={id,role,cn,sn,at:Date.now()};pending.set(id,s);
    json(res,{id,sn:b64(sn),proof:b64(await mac(keys[role].a,proofData(role,cn,sn,'server')))},cors);return;
  }
  if(parts[2]==='auth'){
    const s=pending.get(p.id);pending.delete(p.id);if(!s||Date.now()-s.at>20000||!await equalProof(keys[s.role].a,proofData(s.role,s.cn,s.sn,'client'),p.proof))throw Error('authentication failed');
    if(s.role==='receiver'&&[...clients.values()].some(c=>c.role==='receiver'))throw Error('receiver already connected');
    if(s.role==='sender'&&[...clients.values()].filter(c=>c.role==='sender').length>=5)throw Error('five cameras already connected');
    const k=await sessionKeys(keys[s.role].e,s.cn,s.sn),c={id:s.id,role:s.role,k,rx:0,tx:0,inbox:[],at:Date.now(),busy:false};
    for(const peer of clients.values()){if(peer.role!==c.role){boundedPush(peer,{type:'joined',id:c.id,role:c.role});boundedPush(c,{type:'joined',id:peer.id,role:peer.role});}}
    clients.set(c.id,c);
    const frame=await seal(k.receive,k.receivePrefix,c.tx++,{id:c.id,iceServers,maxCameras:5,...(s.role==='receiver'?{senderUrl:await urlFor('sender')}:{})});json(res,{frame},cors);return;
  }
  if(parts[2]==='rpc'){
    const c=clients.get(p.id);if(!c||c.busy)throw Error('invalid session');c.busy=true;
    try {const value=await open(c.k.send,c.k.sendPrefix,c.rx++,p.frame);c.at=Date.now();const data=dispatch(c,value);json(res,{frame:await seal(c.k.receive,c.k.receivePrefix,c.tx++,data)},cors);}catch(e){expireClient(c.id);throw e;}finally{c.busy=false;}return;
  }
  req.socket.destroy();
})().catch(()=>req.socket.destroy());});
signalServer.headersTimeout=10000;signalServer.requestTimeout=15000;signalServer.maxConnections=40;
signalServer.on('clientError',(_,socket)=>socket.destroy());signalServer.on('upgrade',(_,socket)=>socket.destroy());
const adminServer=https.createServer({...tls,minVersion:'TLSv1.3'},(req,res)=>{void(async()=>{
  const u=new URL(req.url,localOrigin),segments=u.pathname.split('/');
  if(!same(segments[1]??'',adminToken)||req.headers['x-forwarded-for']||req.headers.forwarded||req.headers['cf-connecting-ip']){req.socket.destroy();return;}
  if(req.method!=='GET'){req.socket.destroy();return;}
  const asset=segments.slice(2).join('/');
  if(asset==='pairing'){json(res,{ready:!!publicOrigin,sender:await urlFor('sender'),receiver:await urlFor('receiver'),clients:[...clients.values()].map(c=>({role:c.role,ageSeconds:Math.round((Date.now()-c.at)/1000)}))});return;}
  const files={'':'admin.html','admin.js':'admin.js','style.css':'style.css','qr.js':'qr.js'};
  if(!Object.hasOwn(files,asset)){req.socket.destroy();return;}
  const file=files[asset],data=await readFile(pathJoin(root,'public',file));
  res.writeHead(200,{...headers,'Content-Type':file.endsWith('.js')?'text/javascript;charset=utf-8':file.endsWith('.css')?'text/css;charset=utf-8':'text/html;charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(data);
})().catch(()=>req.socket.destroy());});
const listen=s=>new Promise((ok,no)=>{s.once('error',no);s.listen(s===signalServer?port:adminPort,host,ok);});
await listen(signalServer);await listen(adminServer);
const color={reset:'\x1b[0m',bold:'\x1b[1m',cyan:'\x1b[36m',green:'\x1b[32m',magenta:'\x1b[35m',yellow:'\x1b[33m'};
const link=u=>`\x1b]8;;${u}\x1b\\${u}\x1b]8;;\x1b\\`;
function ready(){console.log(`\n${color.bold}${color.green}server is ready!${color.reset}`);const rows=[[color.magenta,'Authentication / QR',`${localOrigin}/${adminToken}/`],[color.cyan,'Studio',null],[color.green,'Handshake',publicOrigin]];for(let i=0;i<rows.length;i++){const [c,label,u]=rows[i];if(u)console.log(`${c}${i===rows.length-1?'└──':'├──'} ${color.bold}${label}${color.reset}: ${c}${link(u)}${color.reset}`);} }
ready();
if(config.publicOrigin){const u=new URL(config.publicOrigin);if(u.protocol!=='https:')throw Error('publicOrigin must use HTTPS');publicOrigin=u.origin;ready();}
else {
  tunnel=spawn(config.cloudflared??'cloudflared',['tunnel','--no-autoupdate','--url',`https://127.0.0.1:${port}`,'--origin-ca-pool',tls.certPath],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let tail='';const output=b=>{tail=(tail+b.toString()).slice(-8192);const match=tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);if(match&&!publicOrigin){publicOrigin=match[0];ready();}};tunnel.stdout.on('data',output);tunnel.stderr.on('data',output);
  tunnel.on('error',e=>console.error(`cloudflared を起動できません。config.json の cloudflared を確認してください: ${e.message}`));
  tunnel.on('exit',code=>{publicOrigin=null;if(!closing)console.error(`Quick Tunnel が停止しました (${code})。Node.js を再起動してください。`);});
}
const cleanup=setInterval(()=>{const now=Date.now();for(const[id,p]of pending)if(now-p.at>20000)pending.delete(id);for(const[id,c]of clients)if(now-c.at>30000)expireClient(id);},5000);cleanup.unref();
async function shutdown(){if(closing)return;closing=true;clearInterval(cleanup);tunnel?.kill();signalServer.closeAllConnections();adminServer.closeAllConnections();signalServer.close();adminServer.close();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
