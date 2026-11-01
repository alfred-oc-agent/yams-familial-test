import { QRCode, jsQR } from './vendor/qr.js';

export async function drawQR(canvas, text) {
  await QRCode.toCanvas(canvas,text,{errorCorrectionLevel:'L',margin:4,width:600,color:{dark:'#000000',light:'#ffffff'}});
}

// Returns a cancellation function immediately, even while the permission prompt is pending.
export function scanQR(video, onCode, onError) {
  let cancelled=false, stream=null, timer=null, busy=false;
  const canvas=document.createElement('canvas'), context=canvas.getContext('2d',{willReadFrequently:true});
  function stop() {cancelled=true;clearTimeout(timer);stream?.getTracks().forEach(track=>track.stop());video.pause();video.srcObject=null;}
  async function scan() {
    if(cancelled)return;
    if(video.readyState>=2 && !busy) {
      const width=Math.min(video.videoWidth,1280), height=Math.round(video.videoHeight*width/video.videoWidth);
      if(width && height) {
        canvas.width=width;canvas.height=height;context.drawImage(video,0,0,width,height);
        const pixels=context.getImageData(0,0,width,height);
        const code=jsQR(pixels.data,width,height,{inversionAttempts:'dontInvert'});
        if(code) {busy=true;try{const accepted=await onCode(code.data);if(accepted){stop();return;}}finally{busy=false;}}
      }
    }
    if(!cancelled)timer=setTimeout(scan,180);
  }
  (async()=>{
    try {
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:960}},audio:false});
      if(cancelled){stream.getTracks().forEach(track=>track.stop());return;}
      video.srcObject=stream;video.muted=true;video.playsInline=true;await video.play();
      if(!cancelled)scan();
    } catch(error) {if(!cancelled){stop();onError(error);}}
  })();
  return stop;
}
