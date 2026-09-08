import { env,requireEnv } from '../../config/env.js';
export interface MediaProvider {download(url:string,session:string,maxBytes:number,timeoutSeconds:number):Promise<Buffer>;}
/** chef-bot's trusted-host replacement, with redirect and allocation bounds. */
export class WahaMedia implements MediaProvider {
 async download(raw:string,session:string,maxBytes:number,timeoutSeconds:number){
  const source=new URL(raw),url=new URL(requireEnv('WAHA_URL'));
  if(!source.pathname.startsWith('/api/files/')||decodeURIComponent(source.pathname.split('/')[3]??'')!==session)throw new Error('Invalid media path');
  url.pathname=source.pathname;url.search=source.search;
  const response=await fetch(url,{headers:{'X-Api-Key':env.wahaApiKey??''},redirect:'error',signal:AbortSignal.timeout(timeoutSeconds*1000)});
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>maxBytes)throw new Error('Media unavailable');
  const chunks:Uint8Array[]=[];let size=0;
  for await(const chunk of response.body as any){size+=chunk.byteLength;if(size>maxBytes)throw new Error('Media too large');chunks.push(chunk);}
  return Buffer.concat(chunks);
 }
}
