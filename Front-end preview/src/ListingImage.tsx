import {useRef} from 'react';
import {motion,useInView,useReducedMotion,useScroll,useSpring,useTransform,useVelocity,type MotionValue} from 'framer-motion';
import type {Item} from './buyer';

const strips=10;
const response={stiffness:145,damping:24,mass:.65};

function ImageStrip({index,photo,bend,drift}:{index:number;photo:string;bend:MotionValue<number>;drift:MotionValue<number>}){
  const phase=index/(strips-1);
  const y=useTransform(()=>drift.get()+Math.sin(phase*Math.PI)*bend.get());
  const x=useTransform(()=>Math.sin(phase*Math.PI*2)*bend.get()*.2);
  return <motion.div className="listing-image-strip" style={{x,y,clipPath:`inset(0 ${100-(index+1)*100/strips-.25}% 0 ${index*100/strips}%)`}}>
    <img src={photo} alt="" loading="lazy" draggable={false}/>
  </motion.div>;
}

export function ListingImage({item,index,onOpen}:{item:Item;index:number;onOpen:()=>void}){
  const frame=useRef<HTMLAnchorElement>(null);
  const reduced=useReducedMotion();
  const inView=useInView(frame,{margin:"120px"});
  const {scrollYProgress}=useScroll({target:frame,offset:['start end','end start']});
  const progress=useSpring(scrollYProgress,response);
  const speed=useVelocity(scrollYProgress);
  const impulse=useTransform(speed,[-3,0,3],[-17,0,17]);
  const bend=useSpring(impulse,response);
  const zoom=useTransform(progress,[0,.56,1],[1.04,1.19,1.32]);
  const turn=useTransform(progress,[0,.55,1],[8,0,-8]);
  const drift=useTransform(progress,[0,1],[-18,18]);
  return <a className="listing-image" ref={frame} href={'/item/'+encodeURIComponent(item.id)} onClick={event=>{
    if(!event.metaKey&&!event.ctrlKey&&!event.altKey&&!event.shiftKey){event.preventDefault();onOpen();}
  }}>
    <img className="listing-image-base" src={item.photo} alt={item.name} loading={index>1?'lazy':'eager'}/>
    {!reduced&&inView&&<motion.div className="listing-image-plane" aria-hidden="true" style={{scale:zoom,rotateX:turn}}>
      {Array.from({length:strips},(_,i)=><ImageStrip key={i} index={i} photo={item.photo} bend={bend} drift={drift}/>)}
    </motion.div>}
  </a>;
}
