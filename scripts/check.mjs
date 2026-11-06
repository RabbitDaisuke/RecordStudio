import { readdir,readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(dir){for(const e of await readdir(dir,{withFileTypes:true})){const path=`${dir}/${e.name}`;if(e.isDirectory()){if(!['.git','.runtime','dist','.openai'].includes(e.name))await check(path);}else if(/\.(m?js)$/.test(path)){const r=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}else if(path.endsWith('.json'))JSON.parse(await readFile(path,'utf8'));}}
await check('.');console.log('JavaScript syntax and JSON verified');
