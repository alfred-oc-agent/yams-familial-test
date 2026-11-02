import { QRCode, jsQR } from './vendor/qr.js';

export async function drawQR(canvas, text) {
  await QRCode.toCanvas(canvas,text,{errorCorrectionLevel:'L',margin:4,width:600,color:{dark:'#000000',light:'#ffffff'}});
}

// Returns a cancellation function immediately, even while the permission prompt is pending.
export function scanQR(video, onCode, onError) {
  let cancelled=false, stream=null, timer=null, busy=false;
  let detector=null;
  try {if(globalThis.BarcodeDetector)detector=new BarcodeDetector({formats:['qr_code']});} catch {}
  const canvas=document.createElement('canvas'), context=canvas.getContext('2d',{willReadFrequently:true});
  function stop() {cancelled=true;clearTimeout(timer);stream?.getTracks().forEach(track=>track.stop());video.pause();video.srcObject=null;}
  async function scan() {
    if(cancelled)return;
    if(video.readyState>=2 && !busy) {
      let text=null;
      if(detector) {
        try {const codes=await detector.detect(video);text=codes.find(code=>code.rawValue)?.rawValue??null;}
        catch {detector=null;} // Native support varies; keep the bundled offline decoder.
      }
      if(cancelled)return;
      if(!text) {
        // Try the centre at native resolution first, before a bounded full-frame pass.
        const side=Math.min(video.videoWidth,video.videoHeight,1080);
        const crops=[[Math.round((video.videoWidth-side)/2),Math.round((video.videoHeight-side)/2),side,side], [0,0,video.videoWidth,video.videoHeight]];
        for(const [x,y,w,h] of crops) {
          const width=Math.min(w,1280),height=Math.round(h*width/w);
          if(!width||!height)continue;
          canvas.width=width;canvas.height=height;context.drawImage(video,x,y,w,h,0,0,width,height);
          const pixels=context.getImageData(0,0,width,height);
          const code=jsQR(pixels.data,width,height,{inversionAttempts:'dontInvert'});
          if(code){text=code.data;break;}
        }
      }
      if(text && !cancelled) {busy=true;try{const accepted=await onCode(text);if(accepted){stop();return;}}finally{busy=false;}}
    }
    if(!cancelled)timer=setTimeout(scan,180);
  }
  (async()=>{
    try {
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
      if(cancelled){stream.getTracks().forEach(track=>track.stop());return;}
      video.srcObject=stream;video.muted=true;video.playsInline=true;await video.play();
      if(!cancelled)scan();
    } catch(error) {if(!cancelled){stop();onError(error);}}
  })();
  return stop;
}
