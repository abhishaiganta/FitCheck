export type Listing = {
  id: string; name: string; kind: string; finish: string; price: number; distance: number;
  dimensions: [number, number, number]; condition: string; savings: number; pounds: number;
  approx: boolean; photo: string; usdzUrl: string; listingUrl: string;
};

type Seed = [string,string,string,number,number,[number,number,number],string,number,number,boolean];
const seeds: Seed[] = [
  ['Amber mushroom lamp','lamp','amber',0,0.8,[12,12,15],'Like new',64,4,false],
  ['Round walnut side table','side table','warm wood',15,1.2,[18,18,22],'Good',64,11,false],
  ['White oak writing desk','desk','warm wood',25,1.8,[42,22,29],'Good',105,32,false],
  ['Moss lounge chair','chair','green',35,2.2,[29,30,32],'Good',110,28,true],
  ['Brass reading lamp','lamp','brass',10,2.4,[13,13,58],'Good',49,8,true],
  ['Low oak bookshelf','bookshelf','warm wood',0,2.6,[32,12,30],'Fair',55,18,false],
  ['Woven rattan ottoman','ottoman','warm wood',20,3.1,[17,17,16],'Like new',48,7,true],
  ['Cream nightstand','side table','cream',15,3.5,[17,15,22],'Good',50,16,true],
];
export const listings = seeds.map(([name,kind,finish,price,distance,dimensions,condition,savings,pounds,approx],i): Listing => ({
  id:String(i+1),name,kind,finish,price,distance,dimensions,condition,savings,pounds,approx,
  photo:'/furniture/'+(i+1)+'.webp',usdzUrl:'/models/'+(i+1)+'.usdz',
  listingUrl:'https://sandiego.craigslist.org/search/fua?query='+encodeURIComponent(name),
}));
export type Query = { items:string[]; maxPrice:number|null; style:string|null };
const capitalize = (value:string) => value.charAt(0).toUpperCase()+value.slice(1);
export function parseQuery(input:string): Query {
  const lower=input.toLowerCase();
  const itemPatterns = [...lower.matchAll(/(?:desk|reading|floor|table) lamp|side table|nightstand|bookshelf|ottoman|chair|desk|lamp|table|couch|sofa|bed/g)];
  const price=lower.match(/(?:under|below|up to|max(?:imum)?|budget(?: of)?)\s*\$?\s*(\d+)/) ?? lower.match(/\$\s*(\d+)/);
  return {items:[...new Set(itemPatterns.map(match=>capitalize(match[0])))],maxPrice:price ? Number(price[1]) : /\bfree\b/.test(lower)?0:null,style:/(warm wood|walnut|oak|wooden)/.test(lower)?'Warm wood':null};
}
export interface ListingSource { search(query: Query): Promise<Listing[]> }
export function mockSource(demo:boolean): ListingSource {
  return {async search(query) {
    const pool=demo ? listings.slice(0,6) : listings;
    const matched=pool.filter(item => (query.maxPrice===null || item.price<=query.maxPrice) &&
      (!query.items.length || query.items.some(term => {
        const lower=term.toLowerCase();
        return item.name.toLowerCase().includes(lower)||item.kind.includes(lower)||lower.endsWith(' lamp')&&item.kind==='lamp'||lower==='nightstand'&&item.name.includes('nightstand');
      })));
    return query.style ? matched.sort((a,b)=>Number(b.finish==='warm wood')-Number(a.finish==='warm wood')) : matched;
  }};
}
