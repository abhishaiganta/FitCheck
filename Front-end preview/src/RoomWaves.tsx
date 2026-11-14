import {motion,useReducedMotion,useScroll,useSpring,useTransform,useVelocity} from 'framer-motion';

export function RoomWaves(){
  const {scrollY}=useScroll();
  const reduced=useReducedMotion();
  const speed=useVelocity(scrollY);
  const sway=useSpring(useTransform(speed,[-2400,0,2400],[-9,0,9]),{stiffness:110,damping:25});
  const near=useTransform(scrollY,value=>Math.sin(value/430)*35);
  const far=useTransform(scrollY,value=>Math.cos(value/610)*23);
  const rise=useTransform(scrollY,value=>Math.sin(value/740)*48);
  return <div className="room-waves" aria-hidden="true">
    <motion.svg className="room-wave-back" viewBox="0 0 500 1000" preserveAspectRatio="none" style={reduced?undefined:{x:far,y:rise,rotate:sway}}>
      <path d="M-100 130 C110 350 190 3 388 133 S505 364 650 217 L650 735 C442 610 445 924 211 777 S23 639 -100 846Z"/>
    </motion.svg>
    <motion.svg className="room-wave-front" viewBox="0 0 500 1000" preserveAspectRatio="none" style={reduced?undefined:{x:near,rotate:sway}}>
      <path d="M-100 385 C66 199 168 560 348 406 S521 137 640 296 L640 529 C443 579 411 720 276 667 S69 455 -100 681Z"/>
      <path className="room-wave-line" d="M-100 385 C66 199 168 560 348 406 S521 137 640 296"/>
      <path className="room-wave-line" d="M-100 420 C64 237 174 595 354 435 S523 175 640 328"/>
    </motion.svg>
  </div>;
}
