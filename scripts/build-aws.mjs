import { build } from 'esbuild';
import { readdir, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'dist');
await rm(out,{recursive:true,force:true});await mkdir(resolve(out,'lambda'),{recursive:true});await mkdir(resolve(out,'site'),{recursive:true});
await build({entryPoints:[resolve(root,'server/lambda.js')],outfile:resolve(out,'lambda/index.js'),bundle:true,platform:'node',target:'node22',format:'cjs',external:['@electric-sql/pglite'],logLevel:'info'});
await writeFile(resolve(out,'lambda/package.json'),'{"type":"commonjs"}\n');
const media=new Set(['.png','.jpg','.jpeg','.jfif','.webp','.gif','.svg','.ico','.mp3','.wav','.ogg','.webm','.mp4','.woff','.woff2','.ttf']);
async function assets(dir,prefix=''){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  if(entry.name.startsWith('.')||['data','node_modules','test-results','dist','aws','server','scripts','test'].includes(entry.name))continue;
  const relative=prefix+entry.name,path=resolve(dir,entry.name);
  if(entry.isDirectory()){await assets(path,relative+'/');continue;}
  if(!entry.isFile()||(!media.has(extname(entry.name).toLowerCase())&&!['index.html','save-system.js','save-system.css'].includes(relative)))continue;
  const target=resolve(out,'site',relative);await mkdir(resolve(target,'..'),{recursive:true});await copyFile(path,target);
 }
}
await assets(root);console.log('Prepared dist/lambda and dist/site. No AWS resources were created.');
