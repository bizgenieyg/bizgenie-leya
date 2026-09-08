import { env } from '../../config/env.js';
import { GeminiSTT } from './gemini.js';
let warned=false;
export function createSTTProvider(){
 if(!env.sttApiKey){if(!warned){console.warn('stt_disabled_missing_key');warned=true;}return null;}
 return new GeminiSTT(env.sttApiKey,env.sttModel);
}
