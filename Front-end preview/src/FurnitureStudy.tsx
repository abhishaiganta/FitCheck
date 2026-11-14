import {useRef,useState} from 'react';
import {AnimatePresence,motion,useMotionValueEvent,useReducedMotion,useScroll,useSpring,useTransform} from 'framer-motion';
import {ArrowLeft,ArrowRight} from 'lucide-react';
import {samples} from './buyer';

const pieces=['2','1','4'].map(id=>samples.find(item=>item.id===id)!);
const spring={type:'spring',stiffness:135,damping:24,mass:1} as const;

export function FurnitureStudy(){
  const [index,setIndex]=useState(0);
  const stage=useRef<HTMLDivElement>(null);
  const touched=useRef<{x:number;y:number}|null>(null);
  const reduced=useReducedMotion();
  const {scrollYProgress}=useScroll({target:stage,offset:['start 55%','end 85%']});
  const progress=useSpring(scrollYProgress,{stiffness:125,damping:25});
  const zoom=useTransform(progress,[0,.33,.66,1],[1.015,1.34,1.55,1.8]);
  const travel=useTransform(progress,[0,1],['2%','-7%']);
  const lift=useTransform(progress,[0,1],['-1%','8%']);
  const tilt=useTransform(progress,[0,.55,1],[0,-4,3]);
  const marker=useTransform(progress,[0,1],[.025,1]);
  const segment=useRef(0);
  useMotionValueEvent(progress,'change',value=>{
    if(reduced)return;
    const next=value>=.72?2:value>=.37?1:0;
    if(next!==segment.current){segment.current=next;setIndex(next);}
  });
  const item=pieces[index];
  function change(delta:number){
    setIndex(value=>(value+delta+pieces.length)%pieces.length);
  }
  return <div className="study-runway" ref={stage}><figure className="furniture-study">
    <div className="study-media" onTouchStart={event=>{
      touched.current={x:event.touches[0].clientX,y:event.touches[0].clientY};
    }} onTouchCancel={()=>{touched.current=null;}} onTouchEnd={event=>{
      const start=touched.current;touched.current=null;
      const end=event.changedTouches[0];
      if(!start||!end)return;
      const dx=end.clientX-start.x,dy=end.clientY-start.y;
      if(Math.abs(dx)>44&&Math.abs(dx)>Math.abs(dy)*1.5)change(dx<0?1:-1);
    }}>
      <AnimatePresence initial={false}>
          <motion.div className="study-shot" key={item.id} initial={reduced?false:{opacity:0,x:'9%',scale:1.09}} animate={{opacity:1,x:0,scale:1}} exit={reduced?{opacity:0}:{opacity:0,x:'-6%',scale:1.04}} transition={reduced?{duration:0}:spring}>
            <motion.img src={item.photo} alt={item.name} fetchPriority={index===0?'high':'auto'} style={reduced?undefined:{scale:zoom,x:travel,y:lift,rotate:tilt}}/>
          </motion.div>
        </AnimatePresence><div className="study-grid" aria-hidden="true"><i/><i/><i/><i/></div>
      <div className="study-top"><span>Furniture in focus</span><span aria-label={`Piece ${index+1} of ${pieces.length}`}>0{index+1} / 0{pieces.length}</span></div>
      {!reduced&&<div className="study-progress" aria-hidden="true"><motion.i style={{scaleX:marker}}/></div>}
    </div>
    <figcaption className="study-caption">
      <AnimatePresence mode="wait" initial={false}><motion.span key={item.id} initial={reduced?false:{opacity:0,y:6}} animate={{opacity:1,y:0}} exit={{opacity:0}} transition={reduced?{duration:0}:{duration:.17}}><strong>{item.name}</strong><small>{item.dimensions.join(' × ')} in{item.approx?' approx.':''} · Sample</small></motion.span></AnimatePresence>
      <div className="study-actions">
        <button onClick={()=>change(-1)} aria-label="Previous furniture piece"><ArrowLeft size={18}/></button><button onClick={()=>change(1)} aria-label="Next furniture piece"><ArrowRight size={18}/></button>
      </div>
    </figcaption>
  </figure></div>;
}
