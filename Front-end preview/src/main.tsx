import {lazy,Suspense,useEffect,useRef,useState,type FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {AnimatePresence,MotionConfig,motion} from 'framer-motion';
import {ArrowLeft,ArrowRight,ArrowUpRight,AudioLines,Box,ChartNoAxesColumn,Heart,House,Layers,MapPin,Mic,QrCode,Search,X} from 'lucide-react';
import QR from 'qrcode';
import {api,arHref,find,hasApi,money,pickupCost,samples,totalCost,type Item} from './buyer';
import {DetailSheet,spring} from './components';
import {readStore,writeStore} from './state';
import {useVoice} from './voice';
import './style.css';
import './phone.css';
import {FurnitureStudy} from './FurnitureStudy';
import {ListingImage} from './ListingImage';
import {RoomWaves} from './RoomWaves';
const Orbit=lazy(()=>import('./OrbitViewer'));
const examples=['Desk lamp under $30','Small wooden side table','Furniture that ships'];
const fullQuery='Desk lamp and side table under $40, warm wood, I drive a Civic';
const nowPath=()=>location.pathname.replace(/\/$/,'')||'/';
const itemLink=(id:string)=>'/item/'+encodeURIComponent(id);
const supportsAR=()=>document.createElement('a').relList.supports('ar');
function ShareCode({item}:{item:Item}){
  const [src,setSrc]=useState('');
  const url=new URL(itemLink(item.id),location.origin).href;
  useEffect(()=>{let live=true;void QR.toDataURL(url,{margin:2,width:320,errorCorrectionLevel:'M'}).then(data=>{if(live)setSrc(data);}).catch(console.error);return()=>{live=false;};},[url]);
  return <div className="share-code">{src&&<img src={src} alt={'QR code for '+item.name} width="160" height="160"/>}<p>Scan to open this item on another phone.</p><a href={url}>Open item page <ArrowUpRight size={14}/></a></div>;
}
function SpatialAction({item,onPreview,onEvent}:{item:Item;onPreview:()=>void;onEvent:(kind:'ar_view'|'listing_open')=>void}){
  const anchor=useRef<HTMLAnchorElement>(null);
  const href=item.usdzUrl?arHref(item,location.origin):null;
  useEffect(()=>{
    const link=anchor.current;
    const handler=(event:Event)=>{if((event as MessageEvent).data==='_apple_ar_quicklook_button_tapped'){onEvent('listing_open');location.assign(item.listingUrl);}};
    link?.addEventListener('message',handler);return()=>link?.removeEventListener('message',handler);
  },[item.listingUrl,onEvent]);
  if(href&&supportsAR())return <a className="primary spatial" ref={anchor} rel="ar" href={href} aria-label="See it in your room" onClick={()=>onEvent('ar_view')}><img src={item.photo} alt={item.name}/></a>;
  if(item.glbUrl||samples.some(sample=>sample.id===item.id&&sample.usdzUrl===item.usdzUrl))return <button className="primary" onClick={onPreview}><Box size={18}/> 3D preview <ArrowUpRight size={17}/></button>;
  return <p className="unavailable">3D model coming</p>;
}
function App(){
  const [path,setPath]=useState(nowPath),[input,setInput]=useState(''),[searched,setSearched]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [items,setItems]=useState<Item[]>([]),[remoteItem,setRemoteItem]=useState<Item|null>(null),[panel,setPanel]=useState<{item:Item;mode:'3d'|'qr'}|null>(null);
  const [saved,setSaved]=useState(()=>readStore<Item[]>('lr2-saved',[]));
  const [events,setEvents]=useState(()=>readStore<{item:Item;kind:'ar_view'|'listing_open'}[]>('lr2-impact',[]));
  const [summary,setSummary]=useState(''),[pipeline,setPipeline]=useState<{counts?:Record<string,number>;events?:unknown[]}|null>(null);
  const [demo,setDemo]=useState(()=>!hasApi||readStore('lr2-demo',false));
  const [menu,setMenu]=useState(false), lastTap=useRef(0), taps=useRef(0);
  const request=useRef(0), textBox=useRef<HTMLInputElement>(null), retry=useRef<number>(0);
  const recorder=useRef<MediaRecorder|null>(null), held=useRef(false);
  const [recording,setRecording]=useState(false),[micNotice,setMicNotice]=useState('');
  const itemId=path.startsWith('/item/')?path.slice(6):'';
  const item=items.find(x=>x.id===itemId)||saved.find(x=>x.id===itemId)||remoteItem?.id===itemId&&remoteItem||((demo||!hasApi)&&samples.find(x=>x.id===itemId))||null;
  const [curtain,setCurtain]=useState<{kind:'search'|'item';label:string;photo?:string}|null>(null);
  const transitionTimer=useRef<number>(0), curtainTimer=useRef<number>(0);
  function cancelTransition(){
    clearTimeout(transitionTimer.current);
    clearTimeout(curtainTimer.current);
    transitionTimer.current=0;
  }
  useEffect(()=>{
    const stop=()=>{cancelTransition();setCurtain(null);};
    window.addEventListener('popstate',stop);
    return()=>{window.removeEventListener('popstate',stop);cancelTransition();};
  },[]);
  function throughWave(transition:NonNullable<typeof curtain>,action:()=>void){
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){action();return;}
    if(transitionTimer.current)return;
    clearTimeout(curtainTimer.current);
    setCurtain(transition);
    transitionTimer.current=window.setTimeout(action,220);
    curtainTimer.current=window.setTimeout(()=>{transitionTimer.current=0;setCurtain(null);},840);
  }
  function move(url:string){if(url!==path)history.pushState({},'',url);setPath(url);window.scrollTo(0,0);}
  useEffect(()=>{const handler=()=>setPath(nowPath());window.addEventListener('popstate',handler);return()=>{window.removeEventListener('popstate',handler);clearTimeout(retry.current);};},[]);
  useEffect(()=>{if(!itemId||!hasApi)return;let live=true;void api<Item>('item/'+itemId).then(data=>{if(live)setRemoteItem(data);}).catch(console.warn);return()=>{live=false;};},[itemId]);
  useEffect(()=>{if(path!=='/pipeline'||!hasApi)return;let live=true;const poll=()=>void api<typeof pipeline>('pipeline').then(value=>{if(live)setPipeline(value);}).catch(error=>{console.warn(error);if(live)setPipeline(null);});poll();const timer=setInterval(poll,3000);return()=>{live=false;clearInterval(timer);};},[path]);
  async function search(value:string,allowRetry=true){
    const text=value.trim();if(!text)return;
    clearTimeout(retry.current);const version=++request.current;
    setInput(text);setSearched(text);setBusy(true);setError('');setSummary('');move('/');
    try{const result=await find(text,demo);if(version===request.current){setItems(result.results);setSummary(result.spoken_summary??'');}}
    catch(err){console.warn(err);if(version===request.current){setItems([]);setError('Can’t reach listings right now. Retrying…');if(allowRetry)retry.current=window.setTimeout(()=>{if(version===request.current&&nowPath()==='/')void search(text,true);},3000);}}
    finally{if(version===request.current)setBusy(false);}
  }
  const voice=useVoice(text=>void search(text));
  useEffect(()=>{if(voice.notice)textBox.current?.focus();},[voice.notice]);
  async function startRecording(){
    if(!hasApi||demo){voice.start();return;}
    held.current=true;setMicNotice('');
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(!held.current){stream.getTracks().forEach(track=>track.stop());return;}
      const active=new MediaRecorder(stream);recorder.current=active;const parts:Blob[]=[];
      active.ondataavailable=event=>parts.push(event.data);
      active.onstop=()=>{
        stream.getTracks().forEach(track=>track.stop());recorder.current=null;setRecording(false);
        const body=new FormData();const type=active.mimeType||'audio/mp4';body.append('audio',new Blob(parts,{type}),type.includes('mp4')?'voice.m4a':'voice.webm');
        void api<{text:string}>('stt',{method:'POST',body}).then(result=>{if(!result.text.trim())throw new Error('Empty transcript');return search(result.text);}).catch(error=>{console.warn(error);setMicNotice('Didn’t catch that. Try again or type it.');textBox.current?.focus();});
      };
      active.start();setRecording(true);
    }catch(err){console.warn(err);setMicNotice('Microphone is off. Type what you need instead.');textBox.current?.focus();}
  }
  function endRecording(){held.current=false;if(recorder.current?.state==='recording')recorder.current.stop();}
  function log(item:Item,kind:'ar_view'|'listing_open'){
    setEvents(previous=>{const next=[...previous,{item,kind}];writeStore('lr2-impact',next);return next;});
    if(hasApi&&!demo)void api('impact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({listing_id:item.id,kind})}).catch(console.warn);
  }
  function save(item:Item){setSaved(previous=>{const next=previous.some(x=>x.id===item.id)?previous.filter(x=>x.id!==item.id):[...previous,item];writeStore('lr2-saved',next);return next;});}
  function tapLogo(){const now=Date.now();taps.current=now-lastTap.current<650?taps.current+1:1;lastTap.current=now;if(taps.current===3&&hasApi){setMenu(value=>!value);taps.current=0;}move('/');}
  async function speak(){try{
    if(hasApi&&!demo){const result=await api<{url:string}>('tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:summary})});await new Audio(result.url).play();}
    else if(summary&&'speechSynthesis'in window)speechSynthesis.speak(new SpeechSynthesisUtterance(summary));
  }catch(error){console.warn(error);}}
  const card=(entry:Item,index=0)=><motion.article className="piece" key={entry.id} initial={{opacity:0,y:24}} whileInView={{opacity:1,y:0}} viewport={{once:true,amount:.09}} transition={{...spring,delay:(index%3)*.04}}>
    <div className="piece-photo"><ListingImage item={entry} index={index} onOpen={()=>throughWave({kind:'item',label:entry.name,photo:entry.photo},()=>move(itemLink(entry.id)))}/><button className="heart" aria-label={saved.some(x=>x.id===entry.id)?'Remove from saved':'Save '+entry.name} aria-pressed={saved.some(x=>x.id===entry.id)} onClick={()=>save(entry)}><Heart size={19} fill={saved.some(x=>x.id===entry.id)?'currentColor':'none'}/></button></div>
    <div className="piece-info"><div className="piece-title"><h3>{entry.name}</h3><strong>{entry.price===0?'Free':money(totalCost(entry))}</strong></div>
    <p className="logistics">{entry.shipping!==undefined?`Ships for ${money(entry.shipping)} · ${money(totalCost(entry))} total`:`~${entry.distance.toFixed(1)} mi pickup · ${money(pickupCost(entry.distance))} gas est.`}{entry.price===0&&totalCost(entry)>0?` · ${money(totalCost(entry))} total est.`:entry.price>0&&entry.shipping===undefined?' · total est.':''}</p>
    <div className="facts"><span>{entry.dimensions.join(' × ')} in{entry.approx?' approx.':''}</span><span>{entry.condition}</span>{entry.approximateModel&&<span>Approx. model</span>}{entry.carFit&&<span>{entry.carFit}{/^(Fits|Seats folded|Too big)/.test(entry.carFit)?' · est.':''}</span>}</div>
    <p className="saving">Save ~{money(Math.max(0,entry.savings-(totalCost(entry)-entry.price)))} vs. new</p>
    <SpatialAction item={entry} onEvent={kind=>log(entry,kind)} onPreview={()=>{log(entry,'ar_view');setPanel({item:entry,mode:'3d'});}}/>
    <div className="piece-links"><a target="_blank" rel="noopener" href={entry.listingUrl} onClick={()=>log(entry,'listing_open')}>{demo?'Search Craigslist':'View listing'} <ArrowUpRight size={14}/></a><button aria-label={'QR code for '+entry.name} onClick={()=>setPanel({item:entry,mode:'qr'})}><QrCode size={18}/> QR</button></div></div>
  </motion.article>;
  const inventory=demo?samples:items;
  const opened=[...new Map(events.filter(x=>x.kind==='listing_open').map(x=>[x.item.id,x.item])).values()];
  const isHome=path==='/';
  return <><RoomWaves/><header className="site-header"><div className="bar"><button onClick={tapLogo} className="brand">liveroom<span>.</span></button><div className="area"><MapPin size={15}/> UC San Diego</div>{menu&&<button className="mode" onClick={()=>{writeStore('lr2-demo',!demo);setDemo(!demo);setSearched('');setItems([]);setMenu(false);}}>Sample mode {demo?'on':'off'}</button>}</div></header>
  <main>
    {isHome?<><section className={'intro '+(searched?'compact':'')}><div className="intro-content">{!searched&&<><h1 className="study-headline" aria-label="Give good furniture a second room."><span aria-hidden="true"><b>Give good furniture</b></span><span aria-hidden="true"><b>a second room<i>.</i></b></span></h1><p>Find it near campus. See it in your room before you pick it up.</p></>}
      <form className="finder" onSubmit={(event:FormEvent)=>{event.preventDefault();void search(input);}}><Search size={18}/><input ref={textBox} value={input} onChange={e=>setInput(e.target.value)} placeholder="Lamp, side table, under $40…" aria-label="Search furniture" enterKeyHint="search"/><button type="submit" aria-label="Search" disabled={!input.trim()}><ArrowRight size={20}/></button></form>
      <button className="talk" aria-label={recording||voice.listening?'Stop listening':'Talk to search'} data-active={recording||voice.listening} onPointerDown={event=>{if(hasApi&&!demo){event.currentTarget.setPointerCapture(event.pointerId);void startRecording();}}} onPointerUp={endRecording} onPointerCancel={endRecording} onClick={event=>{if(!hasApi||demo)void startRecording();else if(event.detail===0){if(recording)endRecording();else void startRecording();}}}><Mic size={18}/> {recording||voice.listening?'Listening…':hasApi&&!demo?'Hold to talk':'Talk to search'}</button>
      {(voice.transcript&&voice.listening||micNotice||voice.notice)&&<p role="status" className="notice">{voice.listening?voice.transcript:micNotice||voice.notice}</p>}
      {!searched&&<div className="examples quick-searches" aria-label="Quick searches">{examples.map(example=><button key={example} onClick={()=>throughWave({kind:'search',label:example},()=>void search(example))}>{example}</button>)}</div>}
      </div>{!searched&&<FurnitureStudy/>}</section>

      <section className="collection"><div className="collection-heading"><div><p>{demo?'Sample collection':'UC San Diego inventory'}</p><h2>{searched?'Search results':'The nearby edit'}</h2></div>{summary&&<button className="listen" onClick={()=>void speak()} aria-label="Read results aloud"><AudioLines size={19}/></button>}{searched&&<button className="reset" onClick={()=>{request.current++;clearTimeout(retry.current);setSearched('');setInput('');setError('');setSummary('');setBusy(false);}}>Clear</button>}</div>
      {searched&&<p className="origin">From UC San Diego · {busy?'Searching':items.length+' found'}</p>}
      {error?<p className="empty" role="status">{error} <button onClick={()=>void search(searched)}>Retry now</button></p>:busy?<div className="loading" aria-label="Searching listings"/>:<div className="cards">{(searched?items:demo?samples.slice(0,6):[]).map(card)}</div>}
      {!busy&&!error&&searched&&!items.length&&<div className="empty"><p>No matches for “{searched}”.</p><div className="examples"><button onClick={()=>void search(searched.replace(/(?:under|below|up to)\s*\$?\s*[\w]+/gi,'')+' under $60')}>Raise budget</button><button onClick={()=>void search('furniture that ships')}>Show shipped items</button><button onClick={()=>void search(searched.replace(/warm wood|walnut|wooden|oak/gi,''))}>Any style</button></div></div>}
      {!searched&&!demo&&<button className="try-demo" onClick={()=>void search(fullQuery)}>Try the sample search <ArrowUpRight size={16}/></button>}</section>
    </>:itemId?<section className="subpage"><button className="back-link" onClick={()=>move('/')}><ArrowLeft size={17}/> Discover</button>{item?<><div className="cards single">{card(item)}</div><ShareCode item={item}/></>:<h1>Item unavailable.</h1>}</section>:path==='/saved'?<section className="subpage"><h1>Saved pieces<span>.</span></h1>{saved.length?<div className="cards">{saved.map(card)}</div>:<p className="empty">Tap the heart on an item to save it here.</p>}</section>:path==='/pipeline'?<section className="subpage"><h1>Pipeline<span>.</span></h1><p className="origin">{pipeline?'Live job counts · refreshes every 3 seconds':'Live pipeline is unavailable. Connect the team API to see worker activity.'}</p>{pipeline?.counts&&<dl className="metrics">{Object.entries(pipeline.counts).map(([status,count])=><div key={status}><dt>{status.replaceAll('_',' ')}</dt><dd>{count}</dd></div>)}</dl>}</section>:path==='/impact'?<section className="subpage"><h1>Secondhand impact<span>.</span></h1><p className="origin">{demo?'Sample inventory · local activity':'Current results · local activity'}</p><dl className="metrics">{[['Pieces available',inventory.length],['Free pieces',inventory.filter(x=>x.price===0).length],['Potential savings (est.)',money(inventory.reduce((sum,x)=>sum+Math.max(0,x.savings-(totalCost(x)-x.price)),0))],['Spatial previews opened',events.filter(x=>x.kind==='ar_view').length],['Potential landfill diversion (est.)',opened.reduce((sum,x)=>sum+x.pounds,0)+' lb']].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>:<section className="subpage"><h1>Page unavailable.</h1></section>}
  </main>
  <nav className="dock" aria-label="Main navigation">{[['/','Discover',House],['/saved','Saved',Heart],['/pipeline','Pipeline',Layers],['/impact','Impact',ChartNoAxesColumn]].map(([url,label,Icon])=>{const Destination=Icon as typeof House;return <a key={url as string} href={url as string} aria-current={path===url?'page':undefined} onClick={event=>{event.preventDefault();move(url as string);}}><Destination size={19}/>{label as string}</a>;})}</nav>
  {curtain&&<div className="page-wave" data-kind={curtain.kind} aria-hidden="true">
    <div className="page-wave-sheet">
      <div className="wave-loader">
        <div className="wave-loader-orbits"><i/><i/><i/></div>
        <div className="wave-loader-center">{curtain.photo?<img src={curtain.photo} alt=""/>:<Search size={35} strokeWidth={1.4}/>}</div>
        <div className="wave-loader-copy"><span>{curtain.kind==='search'?'Finding furniture':'Opening item'}</span><strong>{curtain.label}</strong></div>
      </div>
    </div>
  </div>}
  <AnimatePresence>{panel?.mode==='3d'&&<DetailSheet item={panel.item} sample={demo} close={()=>setPanel(null)} open={()=>log(panel.item,'listing_open')} viewer={<Suspense fallback={<p>Loading 3D preview…</p>}><Orbit item={panel.item}/></Suspense>}/>}</AnimatePresence>
  {panel?.mode==='qr'&&<div className="qr-overlay" onClick={()=>setPanel(null)}><section role="dialog" aria-modal="true" aria-label="Share item" onClick={event=>event.stopPropagation()} onKeyDown={event=>{if(event.key==='Escape')setPanel(null);}}><button className="close" autoFocus aria-label="Close QR code" onClick={()=>setPanel(null)}><X size={20}/></button><h2>{panel.item.name}</h2><ShareCode item={panel.item}/></section></div>}
  </>;
}
createRoot(document.getElementById('root')!).render(<MotionConfig reducedMotion="user"><App/></MotionConfig>);
if(import.meta.env.PROD&&'serviceWorker'in navigator)void navigator.serviceWorker.register('/sw.js').catch(console.warn);
