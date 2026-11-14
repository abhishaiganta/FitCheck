import {useEffect,useRef,useState} from 'react';
import {motion,useScroll,useSpring,useTransform,useReducedMotion,type PanInfo} from 'framer-motion';
import {ArrowUpRight,Box,Check,Heart,Leaf,MapPin,Mic,Ruler,Sparkles,Square,X} from 'lucide-react';
import type {Listing,Query} from './data';
export const spring={type:'spring',stiffness:260,damping:24} as const;
export const press={scale:.97};
export function ImpactCounter({saved,pounds}:{saved:number;pounds:number}){
  const money=useSpring(0,spring), weight=useSpring(0,spring), reduced=useReducedMotion();
  const dollars=useTransform(money,value=>'$'+Math.round(value));
  const lbs=useTransform(weight,value=>String(Math.round(value)));
  useEffect(()=>{money.set(saved);weight.set(pounds);},[saved,pounds,money,weight]);
  return <div className="impact" aria-label={`$${saved} saved, ${pounds} pounds kept from landfill`}>
    <div className="impact-icon"><Leaf size={20}/></div><div><motion.strong>{reduced?'$'+saved:dollars}</motion.strong><span>saved</span></div>
    <div className="impact-rule"/><div><motion.strong>{reduced?pounds:lbs}</motion.strong><span>lbs kept from landfill</span></div>
  </div>;
}
export function MicOrb({voice}:{voice:ReturnType<typeof import('./voice').useVoice>}){
  return <motion.button className={'mic '+(voice.listening?'active':'')} onClick={voice.start} whileTap={press} transition={spring} aria-label={voice.listening?'Stop listening':'Start voice search'}>
    <span className="mic-ring"/><span className="mic-ring outer"/>
    {voice.listening?<><div className="wave" ref={voice.waveform} aria-hidden="true">{Array.from({length:13},(_,i)=><i key={i}/>)}</div><Square className="stop-mark" size={10}/></>:<Mic size={33} strokeWidth={1.6}/>}
  </motion.button>;
}
export function TranscriptChips({query}:{query:Query}){
  const chips=[...query.items,query.maxPrice===0?'Free':query.maxPrice!==null?'Under $'+query.maxPrice:null,query.style].filter(Boolean);
  return <div className="parsed" aria-label="Search filters">{chips.map((chip,i)=><motion.span layout key={chip} initial={{opacity:0,y:15,scale:.86}} animate={{opacity:1,y:0,scale:1}} transition={{...spring,delay:i*.06}}><Check size={14}/>{chip}</motion.span>)}</div>;
}
export function ARButton({onClick}:{onClick:()=>void}){
  return <motion.button className="ar-button" onClick={onClick} whileTap={press} transition={spring}><Box size={19}/>See it in your room<ArrowUpRight size={17} className="ar-arrow"/></motion.button>;
}
export function ListingCard({item,index,saved,onSave,onSkip,onAR,onDetail}:{item:Listing;index:number;saved:boolean;onSave:()=>void;onSkip?:()=>void;onAR:()=>void;onDetail:()=>void}){
  const ref=useRef<HTMLElement>(null);
  const {scrollYProgress}=useScroll({target:ref,offset:['start end','end start']});
  const y=useTransform(scrollYProgress,[0,1],[-12,12]), tilt=useTransform(scrollYProgress,[0,.5,1],[3,0,-3]);
  const reduced=useReducedMotion();
  const swiped=(_:unknown,info:PanInfo)=>{if(info.offset.x>80&&!saved)onSave();if(info.offset.x< -80)onSkip?.();};
  return <motion.article ref={ref} className="listing" initial={{opacity:0,y:26}} animate={{opacity:1,y:0}} exit={{opacity:0,scale:.96}} transition={{...spring,delay:index*.06}} drag={reduced?false:'x'} dragConstraints={{left:0,right:0}} dragElastic={.35} onDragEnd={swiped}>
    <div className="listing-photo"><motion.img src={item.photo} alt={item.name} draggable={false} loading={index<2?'eager':'lazy'} style={reduced?undefined:{y,rotateX:tilt}}/>
    <span className={'price '+(item.price===0?'free':'')}>{item.price===0?'FREE':'$'+item.price}</span>
    <motion.button className="save" aria-label={saved?'Remove from saved':'Save '+item.name} aria-pressed={saved} onClick={onSave} whileTap={press}><Heart size={20} fill={saved?'currentColor':'none'}/></motion.button></div>
    <div className="listing-body"><div className="listing-title"><h3>{item.name}</h3><span><MapPin size={13}/>{item.distance} mi</span></div>
    <div className="specs"><span><Ruler size={16}/>{item.dimensions.join(' × ')} in {item.approx&&<small>approx.</small>}</span><span className="condition">{item.condition}</span></div>
    <div className="savings"><Leaf size={15}/> Saves ${item.savings} vs new</div>
    <ARButton onClick={onAR}/><button className="text-action" onClick={onDetail}>View listing <ArrowUpRight size={15}/></button>
    {onSkip&&<button className="skip" onClick={onSkip}>Skip</button>}</div>
  </motion.article>;
}
export function FitDiagram({item}:{item:Listing}){
  const [w,d]=item.dimensions;
  return <figure className="fit"><figcaption>Will it fit? <small>Top view · 8 × 6 ft reference area</small></figcaption>
  <svg viewBox="0 0 240 150" role="img" aria-label={`A ${w} by ${d} inch footprint in an 8 by 6 foot area`}>
    <rect x="48" y="17" width="144" height="108" rx="5" className="fit-room"/>
    <rect x={120-w*.75} y={71-d*.75} width={w*1.5} height={d*1.5} rx="2" className="fit-item"/>
    <text x="120" y="143" textAnchor="middle">{w} × {d} in</text>
  </svg></figure>;
}
export function DetailSheet({item,close,open,viewer,sample=true}:{item:Listing;close:()=>void;open:()=>void;viewer?:React.ReactNode;sample?:boolean}){
  const ref=useRef<HTMLDivElement>(null), [expanded,setExpanded]=useState(false);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    ref.current?.focus();const before=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=before;previous?.focus();};
  },[]);
  return <motion.div className="scrim" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} onClick={close}>
    <motion.div className={'sheet '+(expanded?'expanded':'')} ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={item.name} initial={{y:'100%'}} animate={{y:0}} exit={{y:'100%'}} transition={spring} onClick={e=>e.stopPropagation()} onKeyDown={e=>{
      if(e.key==='Escape')close();
      if(e.key==='Tab'){const nodes=Array.from(ref.current?.querySelectorAll<HTMLElement>('button,a[href],[tabindex="0"]')??[]);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===ref.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    }}>
      <motion.button className="sheet-handle" aria-label={expanded?'Collapse details':'Expand details'} drag="y" dragConstraints={{top:0,bottom:0}} dragElastic={.25} onDragEnd={(_,info)=>{if(info.offset.y>80){if(expanded)setExpanded(false);else close();}else if(info.offset.y< -50)setExpanded(true);}} onClick={()=>setExpanded(value=>!value)}><span/></motion.button>
      <button className="sheet-close" aria-label="Close details" onClick={close}><X size={21}/></button>
      <h2>{item.name}</h2><p className="detail-meta">{item.condition} · {item.distance} mi · {item.dimensions.join(' × ')} in{item.approx?' approx.':''}</p>
      {viewer}<FitDiagram item={item}/>
      <a className="ar-button" href={item.listingUrl} target="_blank" rel="noopener noreferrer" onClick={open}>{sample?'Search Craigslist':'View listing'} <ArrowUpRight size={19}/></a>
      {sample&&<p className="sample-note">Sample listing · opens a matching Craigslist search</p>}
    </motion.div>
  </motion.div>;
}
export function Burst({id}:{id:number}){
  if(!id)return null;
  return <div className="burst" aria-hidden="true">{Array.from({length:20},(_,i)=>{
    const angle=i/20*Math.PI*2, radius=75+(i%5)*27;
    return <motion.i key={id+'-'+i} style={{background:i%2?'#D98E32':'#2ECC8F'}} initial={{x:0,y:0,opacity:1,scale:0}} animate={{x:Math.cos(angle)*radius,y:Math.sin(angle)*radius,opacity:0,scale:[0,1,.6],rotate:i*31}} transition={{duration:.85,ease:[.18,.8,.3,1]}}/>;
  })}</div>;
}
export const Sparkle=Sparkles;
