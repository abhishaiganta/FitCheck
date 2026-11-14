import {defineConfig} from 'vite';

export default defineConfig({
  plugins:[{
    name:'offline-assets',
    generateBundle(_,bundle){
      // Include lazy-loaded code so the first offline AR preview also works.
      const paths=Object.keys(bundle).map(name=>'/'+name);
      const version=Object.keys(bundle).find(name=>/^assets\/index-.*\.js$/.test(name));
      this.emitFile({type:'asset',fileName:'offline-assets.json',source:JSON.stringify({version,paths})});
    },
  }],
  build:{rollupOptions:{onwarn(warning,forward){if(warning.code!=='MODULE_LEVEL_DIRECTIVE')forward(warning);}}},
});
