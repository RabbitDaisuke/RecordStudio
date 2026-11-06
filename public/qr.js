// QR Model 2, byte mode, level L. No network or package dependency.
const ECC=[18,20,24,26,30,22,24,28,30,28,28];
const BLOCKS=[4,4,4,4,4,6,6,6,6,7,8];
const mul=(x,y)=>{let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11d);z^=((y>>>i)&1)*x;}return z;};
function divisor(n){const a=new Uint8Array(n);a[n-1]=1;let root=1;for(let i=0;i<n;i++){for(let j=0;j<n;j++){a[j]=mul(a[j],root);if(j+1<n)a[j]^=a[j+1];}root=mul(root,2);}return a;}
function remainder(data,poly){const r=new Uint8Array(poly.length);for(const b of data){const f=b^r[0];r.copyWithin(0,1);r[r.length-1]=0;for(let i=0;i<r.length;i++)r[i]^=mul(poly[i],f);}return r;}
function rawModules(v){let n=(16*v+128)*v+64;if(v>=2){const a=Math.floor(v/7)+2;n-=(25*a-10)*a-55;if(v>=7)n-=36;}return n;}
export function qrMatrix(value){
  const bytes=new TextEncoder().encode(value);let v=10,cap;
  for(;v<=20;v++){cap=Math.floor(rawModules(v)/8)-ECC[v-10]*BLOCKS[v-10];if(bytes.length*8+20<=cap*8)break;}
  if(v>20)throw Error('接続URLが長すぎます。');
  const bits=[];const put=(n,len)=>{for(let i=len-1;i>=0;i--)bits.push((n>>>i)&1);};put(4,4);put(bytes.length,16);for(const b of bytes)put(b,8);put(0,Math.min(4,cap*8-bits.length));while(bits.length%8)bits.push(0);let pad=0;while(bits.length<cap*8)put(pad++%2?0x11:0xec,8);
  const data=Uint8Array.from({length:cap},(_,i)=>bits.slice(i*8,i*8+8).reduce((a,b)=>a*2+b,0)), nb=BLOCKS[v-10],ec=ECC[v-10],total=Math.floor(rawModules(v)/8),shortLen=Math.floor(total/nb),shortBlocks=nb-total%nb,poly=divisor(ec),blocks=[];
  let offset=0;for(let b=0;b<nb;b++){const len=shortLen-ec+(b<shortBlocks?0:1),d=data.slice(offset,offset+len);offset+=len;blocks.push({d,e:remainder(d,poly)});}
  const code=[];for(let i=0;i<=shortLen-ec;i++)for(const b of blocks)if(i<b.d.length)code.push(b.d[i]);for(let i=0;i<ec;i++)for(const b of blocks)code.push(b.e[i]);
  const n=v*4+17,m=Array.from({length:n},()=>Array(n).fill(false)),fn=m.map(r=>r.slice());
  const set=(x,y,d)=>{if(x>=0&&x<n&&y>=0&&y<n){m[y][x]=!!d;fn[y][x]=true;}};
  for(let i=0;i<n;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
  const finder=(x,y)=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy));set(x+dx,y+dy,d!==2&&d!==4);}};finder(3,3);finder(n-4,3);finder(3,n-4);
  const count=Math.floor(v/7)+2,step=v===32?26:Math.floor((v*4+count*2+1)/(count*2-2))*2,positions=[6];for(let p=n-7;positions.length<count;p-=step)positions.splice(1,0,p);
  for(let a=0;a<count;a++)for(let b=0;b<count;b++){if((a===0&&b===0)||(a===0&&b===count-1)||(a===count-1&&b===0))continue;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(positions[a]+dx,positions[b]+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);}
  function format(mask){const d=8|mask;let r=d;for(let i=0;i<10;i++)r=(r<<1)^((r>>>9)*0x537);const f=((d<<10)|r)^0x5412,bit=i=>((f>>>i)&1)!==0;for(let i=0;i<=5;i++)set(8,i,bit(i));set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));for(let i=9;i<15;i++)set(14-i,8,bit(i));for(let i=0;i<8;i++)set(n-1-i,8,bit(i));for(let i=8;i<15;i++)set(8,n-15+i,bit(i));set(8,n-8,true);}
  format(0);let rem=v;for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1f25);const vb=(v<<12)|rem;for(let i=0;i<18;i++){const a=n-11+i%3,b=Math.floor(i/3),d=(vb>>>i)&1;set(a,b,d);set(b,a,d);}
  let ix=0;for(let right=n-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<n;vert++){const up=((right+1)&2)===0,y=up?n-1-vert:vert;for(let j=0;j<2;j++){const x=right-j;if(!fn[y][x]){let bit=ix<code.length*8?(code[ix>>>3]>>>(7-(ix&7)))&1:0;ix++;if((x+y)%2===0)bit^=1;m[y][x]=!!bit;}}}}
  return m;
}
export function drawQr(canvas,value){const m=qrMatrix(value),quiet=4,scale=5,n=(m.length+quiet*2)*scale;canvas.width=canvas.height=n;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,n,n);c.fillStyle='#181818';for(let y=0;y<m.length;y++)for(let x=0;x<m.length;x++)if(m[y][x])c.fillRect((x+quiet)*scale,(y+quiet)*scale,scale,scale);}
