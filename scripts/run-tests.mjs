import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const mode=process.argv[2]??'fast';
// Tests live next to the code in these source folders; each runs from its compiled copy in dist/.
const folders=['services','routes','evals'];
const files=[];
for(const folder of folders){
  const names=await readdir(new URL(`../src/${folder}/`,import.meta.url)).catch(()=>[]);
  files.push(...names
    .filter(name=>name.endsWith('.test.ts'))
    .filter(name=>mode==='full'||!name.endsWith('.integration.test.ts'))
    .sort()
    .map(name=>fileURLToPath(new URL(`../dist/${folder}/${name.replace(/\.ts$/,'.js')}`,import.meta.url))));
}
if(!files.length){console.error('No tests found. Run npm run build first.');process.exit(1)}
const child=spawn(process.execPath,['--test',...files],{stdio:'inherit'});
child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1});
