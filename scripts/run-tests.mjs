import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const mode=process.argv[2]??'fast';
const sourceDirectory=new URL('../src/services/',import.meta.url);
const compiledDirectory=new URL('../dist/services/',import.meta.url);
const files=(await readdir(sourceDirectory))
  .filter(name=>name.endsWith('.test.ts'))
  .filter(name=>mode==='full'||!name.endsWith('.integration.test.ts'))
  .sort()
  .map(name=>fileURLToPath(new URL(name.replace(/\.ts$/,'.js'),compiledDirectory)));
if(!files.length){console.error('No tests found. Run npm run build first.');process.exit(1)}
const child=spawn(process.execPath,['--test',...files],{stdio:'inherit'});
child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1});
