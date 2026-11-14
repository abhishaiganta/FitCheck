import {listings,parseQuery,type Listing} from './data';
export type Item=Listing & {shipping?:number; glbUrl?:string; approximateModel?:boolean; carFit?:string; source?:string; seenAt?:string};
export const money=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:Number.isInteger(value)?0:2}).format(value);
export const pickupCost=(miles:number)=>Math.round(Math.max(0,miles)*30)/100;
export const totalCost=(item:Item)=>item.price+(item.shipping??pickupCost(item.distance));
export function carFit(dimensions:number[],car:{width:number;height:number;depth:number;foldedDepth:number}){
  const [a,b,c]=dimensions;
  const orientations=[[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]];
  const fits=(depth:number)=>orientations.some(([w,h,d])=>w<=car.width&&h<=car.height&&d<=depth);
  return fits(car.depth)?'Fits':fits(car.foldedDepth)?'Seats folded':'Too big';
}
export function arHref(item:Item,origin:string){
  const url=new URL(item.usdzUrl,origin);
  if(url.protocol!=='https:'||!url.pathname.toLowerCase().endsWith('.usdz'))return null;
  const fields={callToAction:'View listing',checkoutTitle:item.name,checkoutSubtitle:`~${item.distance.toFixed(1)} mi · Used`,price:money(totalCost(item))};
  url.hash='allowsContentScaling=0&'+Object.entries(fields).map(([key,value])=>key+'='+encodeURIComponent(value)).join('&');
  return url.href;
}
const endpoint=import.meta.env.VITE_API_BASE?.replace(/\/$/,'');
export async function api<T>(path:string,options?:RequestInit):Promise<T>{
  if(!endpoint)throw new Error('API is unconfigured');
  const response=await fetch(endpoint+'/api/'+path,{...options,signal:AbortSignal.timeout(5500)});
  if(!response.ok)throw new Error(`API ${path}: ${response.status}`);
  return response.json() as Promise<T>;
}
export const hasApi=Boolean(endpoint);
export const samples:Item[]=listings.map(item=>({...item,approximateModel:true,...(item.id==='2'?{shipping:9}:{})}));
export async function find(text:string,demo=false){
  if(hasApi&&!demo)return api<{results:Item[];spoken_summary?:string}>('search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
  const parsed=parseQuery(text.replace(/forty/gi,'40').replace(/thirty/gi,'30').replace(/twenty/gi,'20'));
  const noCar=/no car|don.t (?:have|drive) a car|walkable/i.test(text);
  const car=/\b(civic|corolla|camry|model [3y]|rav4|cr-v|prius|elantra|mazda3|outback|jetta|accord|sentra|wrangler)\b/i.exec(text);
  const results=samples.filter(item=>(parsed.maxPrice===null||(parsed.maxPrice===0?item.price===0:totalCost(item)<=parsed.maxPrice))&&
    (!parsed.items.length||parsed.items.some(term=>item.kind===term.toLowerCase()||term.toLowerCase().endsWith(' lamp')&&item.kind==='lamp'||item.name.toLowerCase().includes(term.toLowerCase())))&&
    (!noCar||item.shipping!==undefined||(item.distance<=1&&item.pounds<=15))&&
    (!/ships only|delivery only|that ships/i.test(text)||item.shipping!==undefined))
    .map(item=>({...item,carFit:!noCar&&car?`Couldn't check your ${car[1][0].toUpperCase()+car[1].slice(1)}`:undefined}));
  return {results,spoken_summary:results.length?`Found ${results.length} pieces. The first is ${results[0].name}.`:undefined};
}
