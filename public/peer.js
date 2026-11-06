const WINDOW=512*1024;
export class Peer extends EventTarget {
  constructor(signal,id,initiator){super();this.signal=signal;this.id=id;this.pc=new RTCPeerConnection({iceServers:signal.iceServers,bundlePolicy:'max-bundle'});this.pendingIce=[];this.order=Promise.resolve();this.sendOrder=Promise.resolve();this.requests=new Map();this.requestId=0;this.sent=0;this.acked=0;this.received=0;this.seq=0;this.rxSeq=0;this.waiters=new Set();this.closed=false;this.offset=0;this.rtt=null;
    this.pc.onicecandidate=e=>{if(e.candidate)signal.send(id,{type:'ice',candidate:e.candidate.toJSON()}).catch(e=>this.error(e));};
    this.pc.onconnectionstatechange=()=>{this.dispatchEvent(new Event('state'));if(['failed','closed'].includes(this.pc.connectionState))this.close();};
    if(initiator){this.attach(this.pc.createDataChannel('recordstudio-v1',{ordered:true}));this.offer();}else this.pc.ondatachannel=e=>{if(this.channel){e.channel.close();return;}this.attach(e.channel);};
  }
  error(e){this.dispatchEvent(new CustomEvent('error',{detail:e}));}
  async offer(){try{await this.pc.setLocalDescription(await this.pc.createOffer());await this.signal.send(this.id,{type:'offer',sdp:this.pc.localDescription.sdp});}catch(e){this.error(e);}}
  async signalMessage(m){if(m.type==='ice'){if(this.pc.remoteDescription)await this.pc.addIceCandidate(m.candidate);else this.pendingIce.push(m.candidate);return;}await this.pc.setRemoteDescription({type:m.type,sdp:m.sdp});for(const c of this.pendingIce.splice(0))await this.pc.addIceCandidate(c);if(m.type==='offer'){await this.pc.setLocalDescription(await this.pc.createAnswer());await this.signal.send(this.id,{type:'answer',sdp:this.pc.localDescription.sdp});}}
  attach(channel){this.channel=channel;channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=128*1024;
    channel.onopen=()=>this.dispatchEvent(new Event('open'));channel.onclose=()=>this.close();channel.onerror=()=>this.error(Error('カメラとの通信を確認してください。'));
    channel.onmessage=e=>{if(typeof e.data==='string'){try{const t=JSON.parse(e.data).type;if(['ack','reply','ping'].includes(t)){this.receive(e.data).catch(e=>this.error(e));return;}}catch{}}this.order=this.order.then(()=>this.receive(e.data)).catch(e=>{this.error(e);this.close();});};
  }
  send(value){if(this.channel?.readyState!=='open')throw Error('カメラへ接続してください。');this.channel.send(JSON.stringify(value));}
  request(type,data={},timeout=20000){const id=++this.requestId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(id);reject(Error('カメラの応答を確認してください。'));},timeout);this.requests.set(id,{resolve,reject,timer});try{this.send({type,...data,request:id});}catch(e){clearTimeout(timer);this.requests.delete(id);reject(e);}});}
  reply(m,data={}){this.send({type:'reply',reply:m.request,...data});}
  async receive(data){
    if(typeof data==='string'){
      if(data.length>64*1024)throw Error('受信メッセージが大きすぎます。');const m=JSON.parse(data);
      if(m.type==='ack'){if(!Number.isSafeInteger(m.bytes)||m.bytes<this.acked||m.bytes>this.sent)throw Error('受信確認が一致しません。');this.acked=m.bytes;for(const f of [...this.waiters])f();return;}
      if(m.type==='reply'){const r=this.requests.get(m.reply);if(r){clearTimeout(r.timer);this.requests.delete(m.reply);m.error?r.reject(Error(m.error)):r.resolve(m);}return;}
      if(m.type==='ping'){this.reply(m,{at:Date.now()});return;}
      if(this.onControl)await this.onControl(m);return;
    }
    if(!(data instanceof ArrayBuffer)||data.byteLength<12||data.byteLength>65536)throw Error('録画データを確認してください。');const h=new DataView(data);if(h.getUint32(0)!==0x52530101||h.getUint32(4)!==this.rxSeq++||h.getUint32(8)!==data.byteLength-12)throw Error('録画データの順序が一致しません。');
    if(!this.onBytes)throw Error('保存先を準備してください。');await this.onBytes(data.slice(12));this.received+=data.byteLength-12;this.send({type:'ack',bytes:this.received});
  }
  async syncClock(){let best={rtt:Infinity,offset:0};for(let i=0;i<5;i++){const a=Date.now(),p=await this.request('ping',{},5000),b=Date.now();if(b-a<best.rtt)best={rtt:b-a,offset:p.at-(a+b)/2};}this.rtt=best.rtt;this.offset=best.offset;return best;}
  waitForWindow(size){if(this.closed)return Promise.reject(Error('カメラとの接続が切れました。'));if(this.sent-this.acked+size<=WINDOW&&this.channel.bufferedAmount<WINDOW)return Promise.resolve();return new Promise((resolve,reject)=>{const check=()=>{if(this.closed)finish(Error('カメラとの接続が切れました。'));else if(this.sent-this.acked+size<=WINDOW&&this.channel.bufferedAmount<WINDOW)finish();};const timer=setTimeout(()=>finish(Error('保存先の応答が途切れました。')),15000);const interval=setInterval(check,50);const finish=e=>{clearTimeout(timer);clearInterval(interval);this.waiters.delete(check);e?reject(e):resolve();};this.waiters.add(check);});}
  write(blob){const task=this.sendOrder.then(async()=>{const max=Math.min(48*1024,(this.pc.sctp?.maxMessageSize||65536)-12);for(let i=0;i<blob.size;i+=max){const part=blob.slice(i,i+max);await this.waitForWindow(part.size);const b=await part.arrayBuffer(),packet=new Uint8Array(12+b.byteLength),h=new DataView(packet.buffer);h.setUint32(0,0x52530101);h.setUint32(4,this.seq++);h.setUint32(8,b.byteLength);packet.set(new Uint8Array(b),12);this.channel.send(packet.buffer);this.sent+=b.byteLength;}});this.sendOrder=task.catch(()=>{});return task;}
  async drain(){await this.sendOrder;while(this.acked<this.sent){await this.waitForWindow(WINDOW);}}
  close(){if(this.closed)return;this.closed=true;for(const r of this.requests.values()){clearTimeout(r.timer);r.reject(Error('接続が終了しました。'));}this.requests.clear();for(const f of [...this.waiters])f();this.channel?.close();this.pc.close();this.dispatchEvent(new Event('close'));}
}
