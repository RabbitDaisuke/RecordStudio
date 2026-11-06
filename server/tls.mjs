import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const buf = (...xs) => Buffer.concat(xs.map(x=>Buffer.from(x)));
function der(tag, ...items) { const b=buf(...items), n=b.length; const len=n<128?Buffer.from([n]):Buffer.from(n<256?[0x81,n]:[0x82,n>>8,n&255]);return buf([tag],len,b); }
const seq=(...x)=>der(0x30,...x), set=(...x)=>der(0x31,...x);
function oid(s) { const ns=s.split('.').map(Number), out=[40*ns[0]+ns[1]]; for(const n of ns.slice(2)){let v=n,a=[v&127];while(v>>=7)a.unshift((v&127)|128);out.push(...a);}return der(6,out); }
const algorithm=()=>seq(oid('1.2.840.113549.1.1.11'),der(5,[]));
const pem=(label,b)=>`-----BEGIN ${label}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
export async function localCertificate(dir,listenIp='127.0.0.1') {
  await mkdir(dir,{recursive:true,mode:0o700});
  const keyPath=join(dir,'localhost-key.pem'),certPath=join(dir,'localhost-cert.pem');
  try { const [key,cert]=await Promise.all([readFile(keyPath),readFile(certPath)]);const x=new X509Certificate(cert);if(Date.parse(x.validTo)>Date.now()+86400000&&x.checkIP('127.0.0.1')&&x.checkIP(listenIp))return {key,cert,certPath}; } catch {}
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const name=seq(set(seq(oid('2.5.4.3'),der(12,Buffer.from('RecordStudio localhost')))));
  const time=d=>der(24,Buffer.from(d.toISOString().replace(/[-:T]/g,'').replace(/\.\d+Z$/,'Z')));
  const now=Date.now();const serial=randomBytes(16);serial[0]&=0x7f;serial[0]|=1;
  const extensions=der(0xa3,seq(
    seq(oid('2.5.29.19'),der(1,[255]),der(4,seq(der(1,[255])))),
    seq(oid('2.5.29.17'),der(4,seq(...[...new Set(['127.0.0.1',listenIp])].map(ip=>der(0x87,ip.split('.').map(Number))),der(0x82,Buffer.from('localhost'))))),
    seq(oid('2.5.29.37'),der(4,seq(oid('1.3.6.1.5.5.7.3.1'))))
  ));
  const tbs=seq(der(0xa0,der(2,[2])),der(2,serial),algorithm(),name,seq(time(new Date(now-86400000)),time(new Date(now+365*86400000))),name,publicKey.export({type:'spki',format:'der'}),extensions);
  const cert=Buffer.from(pem('CERTIFICATE',seq(tbs,algorithm(),der(3,buf([0],sign('sha256',tbs,privateKey)))))),key=Buffer.from(privateKey.export({type:'pkcs8',format:'pem'}));
  new X509Certificate(cert);
  await writeFile(keyPath,key,{mode:0o600});await writeFile(certPath,cert,{mode:0o600});return {key,cert,certPath};
}
