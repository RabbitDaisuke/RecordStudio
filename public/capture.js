import { MAX_QUEUE } from './storage.js';
export const stamp=()=>new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
export function chooseMime(choice='auto'){
  const options={h264:['video/mp4;codecs=avc1.42E033','video/mp4;codecs=avc1.42001f','video/mp4','video/webm;codecs=h264'],vp8:['video/webm;codecs=vp8'],vp9:['video/webm;codecs=vp9'],av1:['video/webm;codecs=av01']};
  for(const m of(choice==='auto'?[...options.h264,...options.vp8]:options[choice]??[]))if(MediaRecorder.isTypeSupported(m))return m;
  throw Error('録画形式を「自動」に変更してください。');
}
export async function openCamera(deviceId,quality='max',fps='60',audio=false){
  const sizes={max:[7680,4320],'4k':[3840,2160],'1080':[1920,1080],'720':[1280,720]},[width,height]=sizes[quality]??sizes.max;
  const video={width:{ideal:width},height:{ideal:height},frameRate:{ideal:fps==='max'?120:Number(fps)}};if(deviceId)video.deviceId={exact:deviceId};else video.facingMode={ideal:'environment'};
  return navigator.mediaDevices.getUserMedia({video,audio:audio?{echoCancellation:false,noiseSuppression:false,autoGainControl:false}:false});
}
export class Capture extends EventTarget {
  constructor(stream,{codec='auto',bitrate='auto',write,onError=()=>{}}){super();this.stream=stream;this.mime=chooseMime(codec);const s=stream.getVideoTracks()[0].getSettings();this.settings=s;this.bitrate=bitrate==='auto'?Math.round(Math.min(120e6,Math.max(8e6,(s.width??1920)*(s.height??1080)*(s.frameRate??30)*.22))):Number(bitrate)*1e6;this.write=write;this.onError=onError;this.queue=Promise.resolve();this.queued=0;this.bytes=0;this.failed=false;this.recorder=new MediaRecorder(stream,{mimeType:this.mime,videoBitsPerSecond:this.bitrate,audioBitsPerSecond:256000});
    this.done=new Promise(resolve=>this.resolveDone=resolve);
    this.recorder.addEventListener('dataavailable',e=>{const blob=e.data;if(!blob.size)return;if(this.queued+blob.size>MAX_QUEUE){this.fail(Error('書き込みが追いつかないため収録を停止しました。'));return;}this.queued+=blob.size;this.queue=this.queue.then(async()=>{try{if(!this.failed){for(let i=0;i<blob.size;i+=64*1024)await this.write(blob.slice(i,i+64*1024));this.bytes+=blob.size;}}catch(e){this.fail(e);}finally{this.queued-=blob.size;}});});
    this.recorder.addEventListener('stop',()=>{this.queue.then(()=>{this.complete=true;this.resolveDone({bytes:this.bytes,failed:this.failed});});},{once:true});
    this.recorder.addEventListener('error',e=>this.fail(e.error??Error('録画を停止しました。')));
    for(const t of stream.getTracks())t.addEventListener('ended',()=>this.fail(Error('カメラとの接続が切れました。')),{once:true});
  }
  fail(e){if(this.failed||this.complete)return;this.failed=true;this.onError(e);if(this.recorder.state!=='inactive')this.recorder.stop();else this.resolveDone({bytes:this.bytes,failed:true});}
  start(){this.startedAt=Date.now();this.recorder.start(500);}
  async stop(){if(!this.startedAt){this.complete=true;return {bytes:0,failed:this.failed};}if(this.recorder.state!=='inactive')this.recorder.stop();return this.done;}
}
