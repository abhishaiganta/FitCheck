import {createContext,useContext,useState,type ReactNode} from 'react';
export function readStore<T>(key:string,fallback:T):T {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}
export function writeStore<T>(key:string,value:T) {
  try { localStorage.setItem(key,JSON.stringify(value)); } catch { /* Private browsing may deny storage. */ }
}
const DemoContext=createContext({demo:false,toggle:()=>{}});
export function DemoModeProvider({children}:{children:ReactNode}) {
  const [demo,setDemo]=useState(()=>readStore('liveroom-demo',false));
  return <DemoContext.Provider value={{demo,toggle:()=>{writeStore('liveroom-demo',!demo);setDemo(!demo);}}}>{children}</DemoContext.Provider>;
}
export const useDemo=()=>useContext(DemoContext);
