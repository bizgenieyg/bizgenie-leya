export interface Transcription {text:string;confidence:number;ambiguous:boolean;language:'he'|'ru'|'en';usage?:Record<string,unknown>;}
export interface STTProvider {transcribe(bytes:Buffer,mime:string,timeoutSeconds:number):Promise<Transcription>;}
