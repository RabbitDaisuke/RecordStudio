const files=new Map();
self.onmessage=async({data:m})=>{try{
  let value;
  if(m.op==='open'){const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('recordstudio',{create:true}),fh=await dir.getFileHandle(m.name,{create:true}),h=await fh.createSyncAccessHandle();h.truncate(0);files.set(m.name,{h,offset:0,flushed:0});value=true;}
  if(m.op==='write'){const f=files.get(m.name);if(!f)throw Error('保存先が閉じられています。');const b=new Uint8Array(m.buffer);let n=0;while(n<b.length){const written=f.h.write(b.subarray(n),{at:f.offset+n});if(!written)throw Error('空き容量を確認してください。');n+=written;}f.offset+=n;if(f.offset-f.flushed>=2*1024*1024){f.h.flush();f.flushed=f.offset;}value=f.offset;}
  if(m.op==='close'){const f=files.get(m.name);if(f){f.h.flush();f.h.close();files.delete(m.name);}value=true;}
  self.postMessage({id:m.id,value});
}catch(e){self.postMessage({id:m.id,error:e.message});}};
