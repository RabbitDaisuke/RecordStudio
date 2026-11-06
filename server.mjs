import https from 'node:https';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { localCertificate } from './server/tls.mjs';
import {persistentAuthentication,installationKey} from './server/auth.mjs';
import { b64, un64, mac, equalProof, random, sessionKeys, proofData, seal, open, wrapPair } from './public/crypto.js';

const root=dirname(fileURLToPath(import.meta.url));
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
const decode32=s=>{const b=un64(String(s));if(b.length!==32)throw Error('invalid nonce');return b;};
const configPath=pathJoin(root,'config.json');let config;
try { config=JSON.parse(await readFile(configPath,'utf8')); } catch(e) { if(e.code==='ENOENT')config=JSON.parse(await readFile(pathJoin(root,'config.example.json'),'utf8'));else throw e; }
let host;try {host=(await readFile(pathJoin(root,'ip.txt'),'utf8')).trim();}catch{throw Error('ip.txt がありません。このPCの待受用IPv4アドレスをUTF-8で一行指定してください。');}
if(isIP(host)!==4)throw Error('ip.txt に、このPCの待受用IPv4アドレスをUTF-8で一行指定してください。例: 192.168.1.10');
const port=Number(config.port??9443);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid port');
const appUrl=new URL(config.appUrl);if(appUrl.protocol!=='https:'||appUrl.username||appUrl.password||appUrl.hash)throw Error('config.appUrl must be HTTPS');
const allowedOrigins=new Set([appUrl.origin]);for(const o of config.allowedAppOrigins??[]){const u=new URL(o);if(u.protocol!=='https:'||u.origin!==o)throw Error('invalid allowedAppOrigins');allowedOrigins.add(o);}
const iceServers=config.iceServers??[];if(!Array.isArray(iceServers)||iceServers.length>8)throw Error('invalid iceServers');
for(const s of iceServers){for(const u of [s.urls].flat()){if(typeof u!=='string'||!/^(stun|stuns|turn|turns):[^\s]+$/.test(u))throw Error('invalid ICE URL');}}
const authentication=await persistentAuthentication(pathJoin(root,'.runtime'));
const token=authentication.token,adminToken=createHash('sha512').update(installationKey(authentication.seed,'local-admin')).digest('hex');
const tokenBytes=Buffer.from(token,'hex');
const validUrlToken=value=>typeof value==='string'&&/^[a-f0-9]{128}$/.test(value)&&timingSafeEqual(Buffer.from(value,'hex'),tokenBytes);
const keys=Object.fromEntries(['receiver','sender'].map(role=>[role,{a:installationKey(authentication.seed,role+'/auth'),e:installationKey(authentication.seed,role+'/encryption')}]));
const pending=new Map(),clients=new Map();let publicOrigin=null,tunnel=null,closing=false;
const budgets=new Map();let globalWindow=Date.now(),globalRequests=0;
function requester(req){const socketIP=req.socket.remoteAddress??'';const forwarded=req.headers['cf-connecting-ip'];return [host,'127.0.0.1','::1','::ffff:127.0.0.1'].includes(socketIP)&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:socketIP;}
function budget(req){const now=Date.now();if(now-globalWindow>=10000){globalWindow=now;globalRequests=0;}const id=requester(req);let b=budgets.get(id);if(!b||now-b.at>=10000){if(!b&&budgets.size>=1024)return null;b={at:now,requests:0,failures:0,hellos:0};budgets.set(id,b);}if(++b.requests>300||b.failures>=8)return null;if(++globalRequests>600)return null;return b;}
const tunnelIp=host==='0.0.0.0'?'127.0.0.1':host;
const tls=await localCertificate(pathJoin(root,'.runtime'),tunnelIp);const adminPort=port+1;if(adminPort>65535)throw Error('port too high');
const localOrigin=`https://127.0.0.1:${adminPort}`;
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Strict-Transport-Security':'max-age=31536000'};
const invitationCache=new Map();
const urlFor=async role=>{if(!publicOrigin)return null;const cacheKey=publicOrigin+'|'+role;if(invitationCache.has(cacheKey))return invitationCache.get(cacheKey);const build=(async()=>{const pair={v:1,u:`${publicOrigin}/${token}`,a:b64(keys[role].a),e:b64(keys[role].e),r:role};const u=new URL(`${publicOrigin}/${token}/connect/${role}`);u.hash='pair='+await wrapPair(pair);return u.href;})();invitationCache.set(cacheKey,build);return build;};
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
const signalServer=https.createServer({...tls,minVersion:'TLSv1.3',maxHeaderSize:4096,handshakeTimeout:5000},(req,res)=>{void (async()=>{
  const rate=budget(req);if(!rate){req.socket.destroy();return;}
  const u=new URL(req.url,'https://localhost');const parts=u.pathname.split('/');
  if(!validUrlToken(parts[1])){rate.failures++;req.socket.destroy();return;}
  if(req.method==='GET'&&parts.length===4&&parts[2]==='connect'&&['sender','receiver'].includes(parts[3])){
    const target=parts[3]==='sender'?new URL('camera.html',appUrl).href:appUrl.href;
    const script=`const target=new URL(${JSON.stringify(target)});if(!location.hash.startsWith('#pair=rsk2.')){document.getElementById('status').textContent='認証ページの接続URLを開いてください。';}else{target.hash=location.hash;location.replace(target.href);}`;
    const scriptHash=createHash('sha256').update(script).digest('base64');
    const page=`<!doctype html><html lang="ja"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>RecordStudio 接続</title><p id="status">接続しています。</p><script>${script}</script></html>`;
    res.writeHead(200,{...headers,'Content-Type':'text/html;charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'sha256-${scriptHash}'; base-uri 'none'; frame-ancestors 'none'`});res.end(page);return;
  }
  const origin=req.headers.origin;
  if(!allowedOrigins.has(origin)){req.socket.destroy();return;}
  const cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'content-type','Access-Control-Max-Age':'600'};
  if(req.method==='OPTIONS'){res.writeHead(204,{...headers,...cors});res.end();return;}
  if(req.method!=='POST'||parts.length!==3){req.socket.destroy();return;}
  const p=await body(req);
  if(parts[2]==='hello'){
    if(++rate.hellos>8){req.socket.destroy();return;}
    if(pending.size>=32||clients.size>=8)throw Error('room full');const role=p.role;if(!keys[role])throw Error('invalid role');
    const cn=decode32(p.cn),sn=random(32),id=b64(random(16));
    const s={id,role,cn,sn,at:Date.now()};pending.set(id,s);
    json(res,{id,sn:b64(sn),proof:b64(await mac(keys[role].a,proofData(role,cn,sn,'server')))},cors);return;
  }
  if(parts[2]==='auth'){
    const s=pending.get(p.id);pending.delete(p.id);if(!s||Date.now()-s.at>20000||!await equalProof(keys[s.role].a,proofData(s.role,s.cn,s.sn,'client'),p.proof)){rate.failures++;throw Error('authentication failed');}
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
signalServer.headersTimeout=5000;signalServer.requestTimeout=12000;signalServer.maxConnections=40;signalServer.keepAliveTimeout=5000;
signalServer.setTimeout(12000,socket=>socket.destroy());
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
const listen=s=>new Promise((ok,no)=>{s.once('error',no);s.listen(s===signalServer?port:adminPort,s===signalServer?host:'127.0.0.1',ok);});
await listen(signalServer);await listen(adminServer);
const color={reset:'\x1b[0m',bold:'\x1b[1m',cyan:'\x1b[36m',green:'\x1b[32m',magenta:'\x1b[35m',yellow:'\x1b[33m'};
const link=u=>`\x1b]8;;${u}\x1b\\${u}\x1b]8;;\x1b\\`;
async function ready(){const rows=[[color.magenta,'Authentication / QR',`${localOrigin}/${adminToken}/`],[color.cyan,'Studio',await urlFor('receiver')],[color.green,'Camera / Handshake',await urlFor('sender')]].filter(([, ,u])=>u);console.log(`\n${color.bold}${color.green}server is ready!${color.reset}`);for(let i=0;i<rows.length;i++){const[c,label,u]=rows[i];console.log(`${c}${i===rows.length-1?'└──':'├──'} ${color.bold}${label}${color.reset}: ${c}${link(u)}${color.reset}`);}}
ready();
if(config.publicOrigin){const u=new URL(config.publicOrigin);if(u.protocol!=='https:')throw Error('publicOrigin must use HTTPS');publicOrigin=u.origin;ready();}
else {
  tunnel=spawn(config.cloudflared??'cloudflared',['tunnel','--no-autoupdate','--url',`https://${tunnelIp}:${port}`,'--origin-ca-pool',tls.certPath],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let tail='';const output=b=>{tail=(tail+b.toString()).slice(-8192);const match=tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);if(match&&!publicOrigin){publicOrigin=match[0];ready();}};tunnel.stdout.on('data',output);tunnel.stderr.on('data',output);
  tunnel.on('error',e=>console.error(`cloudflared を起動できません。config.json の cloudflared を確認してください: ${e.message}`));
  tunnel.on('exit',code=>{publicOrigin=null;if(!closing)console.error(`Quick Tunnel が停止しました (${code})。Node.js を再起動してください。`);});
}
const cleanup=setInterval(()=>{const now=Date.now();for(const[id,b]of budgets)if(now-b.at>10000)budgets.delete(id);for(const[id,p]of pending)if(now-p.at>20000)pending.delete(id);for(const[id,c]of clients)if(now-c.at>30000)expireClient(id);},5000);cleanup.unref();
async function shutdown(){if(closing)return;closing=true;clearInterval(cleanup);tunnel?.kill();signalServer.closeAllConnections();adminServer.closeAllConnections();signalServer.close();adminServer.close();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
