import {useEffect,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {SVGRenderer} from 'three/addons/renderers/SVGRenderer.js';
type GeometryPart={vertices:number[][];triangles:number[];color:[number,number,number]};
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import type {Item} from './buyer';
export default function OrbitViewer({item}:{item:Item}){
  const mount=useRef<HTMLDivElement>(null), [failed,setFailed]=useState(false);
  useEffect(()=>{
    const element=mount.current;if(!element)return;
    let renderer:THREE.WebGLRenderer|SVGRenderer;
    try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch{renderer=new SVGRenderer();renderer.setQuality('low');}
    const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(36,1,.01,50);
    camera.position.set(1.6,1.2,2);
    if(renderer instanceof THREE.WebGLRenderer)renderer.setPixelRatio(Math.min(devicePixelRatio,2));element.append(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xfff4e4,.8));
    scene.add(new THREE.HemisphereLight(0xfff5de,0x6a5946,2.6));
    const key=new THREE.DirectionalLight(0xffe1b6,2.3);key.position.set(2,4,3);scene.add(key);
    const controls=new OrbitControls(camera,element);
    controls.enablePan=false;controls.enableDamping=false;controls.minDistance=.25;controls.maxDistance=7;
    const draw=()=>renderer.render(scene,camera);
    controls.addEventListener('change',draw);
    const observer=new ResizeObserver(()=>{const {clientWidth:w,clientHeight:h}=element;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();draw();});
    observer.observe(element);
    let alive=true;
    const dispose=(object:THREE.Object3D)=>object.traverse(node=>{if(node instanceof THREE.Mesh){node.geometry.dispose();for(const material of [node.material].flat())material.dispose();}});
    const request=new AbortController();
    const model = item.glbUrl ? new GLTFLoader().loadAsync(item.glbUrl).then(result=>result.scene) : fetch('/models/'+item.id+'.json',{signal:request.signal}).then(async response=>{
      if(!response.ok)throw new Error('Model unavailable');
      const parts=await response.json() as GeometryPart[];
      const object=new THREE.Group();
      for(const part of parts){
        const geometry=new THREE.BufferGeometry();
        geometry.setAttribute('position',new THREE.Float32BufferAttribute(part.vertices.flat(),3));
        geometry.setIndex(part.triangles);
        geometry.computeVertexNormals();
        const material=new THREE.MeshLambertMaterial({color:new THREE.Color(...part.color),side:THREE.DoubleSide});
        object.add(new THREE.Mesh(geometry,material));
      }
      return object;
    });
    void model.then(object=>{
      if(!alive){dispose(object);return;}
      scene.add(object);const bounds=new THREE.Box3().setFromObject(object);
      const center=bounds.getCenter(new THREE.Vector3()), size=bounds.getSize(new THREE.Vector3()).length();
      controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(1,.7,1.15).multiplyScalar(size));controls.update();draw();
    }).catch(()=>{if(alive)setFailed(true);});
    return()=>{alive=false;request.abort();observer.disconnect();controls.dispose();dispose(scene);if(renderer instanceof THREE.WebGLRenderer)renderer.dispose();renderer.domElement.remove();};
  },[item.id,item.glbUrl]);
  return <div className="orbit-wrap"><div className="orbit" ref={mount} aria-label="Interactive 3D furniture preview"/>{failed&&<img src={item.photo} alt={item.name}/>}<small>{failed?'3D preview unavailable · photo shown':'Drag to rotate · pinch or scroll to zoom · sample model'}</small></div>;
}
