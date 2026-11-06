import { cp,mkdir,rm,writeFile } from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist',{recursive:true});await cp('public','dist',{recursive:true});await writeFile('dist/.nojekyll','');console.log('Built public/ → dist/');
