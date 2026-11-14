import {useEffect,useRef,useState} from 'react';

interface Recognition extends EventTarget {
  continuous:boolean; interimResults:boolean; lang:string;
  onresult:((event:{results:ArrayLike<ArrayLike<{transcript:string}>>})=>void)|null;
  onend:(()=>void)|null; onerror:(()=>void)|null;
  start():void; stop():void; abort():void;
}
type VoiceWindow=Window & {SpeechRecognition?:new()=>Recognition; webkitSpeechRecognition?:new()=>Recognition};
export function useVoice(onSubmit:(text:string)=>void) {
  const [listening,setListening]=useState(false);
  const [transcript,setTranscript]=useState('');
  const [notice,setNotice]=useState('');
  const waveform=useRef<HTMLDivElement>(null);
  const session=useRef<{recognition:Recognition; close:()=>void}|null>(null);
  useEffect(()=>()=>{session.current?.close();session.current?.recognition.abort();},[]);
  function start() {
    if(session.current){session.current.recognition.stop();return;}
    const browser=window as VoiceWindow;
    const Engine=browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if(!Engine){setNotice('Voice search is unavailable here. Try typing or pick a suggestion.');return;}
    const recognition=new Engine();
    let latest='', active=true, stream:MediaStream|undefined, audio:AudioContext|undefined, frame=0;
    const close=()=>{active=false;cancelAnimationFrame(frame);stream?.getTracks().forEach(track=>track.stop());void audio?.close().catch(()=>{});};
    session.current={recognition,close};
    recognition.lang='en-US';recognition.interimResults=true;recognition.continuous=false;
    recognition.onresult=event=>{
      latest=Array.from(event.results,result=>result[0].transcript).join(' ').trim();
      if(active)setTranscript(latest);
    };
    recognition.onend=()=>{
      if(!active)return;
      close();session.current=null;setListening(false);
      if(latest)onSubmit(latest);else setNotice('I didn’t catch that. Try again or type what you need.');
    };
    recognition.onerror=()=>{
      if(!active)return;
      close();session.current=null;setListening(false);setNotice('Voice search couldn’t start. You can type or try a suggestion.');
    };
    setNotice('');setTranscript('');setListening(true);
    try { recognition.start(); } catch { recognition.onerror();return; }
    void navigator.mediaDevices?.getUserMedia({audio:true}).then(input=>{
      if(!active){input.getTracks().forEach(track=>track.stop());return;}
      stream=input; audio=new AudioContext();void audio.resume().catch(()=>{});
      const analyser=audio.createAnalyser();analyser.fftSize=128;
      audio.createMediaStreamSource(input).connect(analyser);
      const bins=new Uint8Array(analyser.frequencyBinCount);
      const draw=()=>{
        analyser.getByteFrequencyData(bins);
        if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
          Array.from(waveform.current?.children ?? []).forEach((bar,i)=>{
            (bar as HTMLElement).style.transform='scaleY('+(.18+(bins[i*2]??0)/255*1.25)+')';
          });
        }
        frame=requestAnimationFrame(draw);
      };
      draw();
    }).catch(()=>{});
  }
  function cancel(){const current=session.current;if(current){current.close();current.recognition.abort();session.current=null;}setListening(false);}
  return {start,cancel,listening,transcript,notice,waveform};
}
