import {randomBytes,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function persistentAuthentication(dir){
  await mkdir(dir,{recursive:true,mode:0o700});const path=join(dir,'authentication.json');
  async function read(){const value=JSON.parse(await readFile(path,'utf8')),seed=Buffer.from(value.seed??'','base64');if(value.version!==1||seed.length!==1024||!(/^[0-9a-f]{64}$/).test(value.sha256??''))throw Error('保存された認証情報が不正です。');const hash=createHash('sha256').update(seed).digest('hex');if(!timingSafeEqual(Buffer.from(hash),Buffer.from(value.sha256)))throw Error('保存された認証情報が一致しません。');return {seed,seedHash:hash,token:createHash('sha512').update(seed).digest('hex')};}
  try{return await read();}catch(e){if(e.code!=='ENOENT')throw e;}
  const seed=randomBytes(1024),seedHash=createHash('sha256').update(seed).digest('hex'),token=createHash('sha512').update(seed).digest('hex');
  try{await writeFile(path,JSON.stringify({version:1,seed:seed.toString('base64'),sha256:seedHash})+'\n',{flag:'wx',mode:0o600});return {seed,seedHash,token};}catch(e){if(e.code==='EEXIST')return read();throw e;}
}
export function installationKey(seed,label){return createHmac('sha256',seed).update('recordstudio/installation/v1/'+label,'utf8').digest();}
