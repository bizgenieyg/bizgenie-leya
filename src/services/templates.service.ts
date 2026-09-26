import { TEMPLATE_DEFAULTS } from '../config/templates.js';
import type { OwnerSettings } from './owner-settings.service.js';
export const languageOf=(text:string):string=>/[א-ת]/.test(text)?'he':/[а-яё]/i.test(text)?'ru':'en';
export type ClientLanguage='he'|'ru'|'en';
export function replyLanguage(text:string,client?:{language?:string|null;language_overridden?:boolean}):ClientLanguage {
  if(client?.language_overridden&&['he','ru','en'].includes(String(client.language)))return client.language as ClientLanguage;
  return languageOf(text) as ClientLanguage;
}
export function renderText(settings:OwnerSettings|undefined,key:string,language:string,values:Record<string,string|number>={}):string {
  const defaults=TEMPLATE_DEFAULTS[key];
  if(!defaults)throw new Error('Unknown template');
  const fallback=defaults[language]??defaults.ru??defaults.en!;
  const candidate=settings?.templates?.[key]?.[language];
  // Old tenants may retain the former department-choice template. It exposed
  // internal route codes through {agents}; normalize it at read time.
  const template=typeof candidate==='string'&&!(key==='client.reception_question'&&(/\{agents\}|\b(?:SALE|SUPPORT|RECEPTION|CORE)\b/.test(candidate)))?candidate:fallback;
  const render=(v:string)=>v.replace(/\{([a-z_]+)\}/g,(_all,k:string)=>String(values[k]??''));
  const clean=(v:string)=>v.replace(/<[^>]*>/g,'').replace(/[<>{}]/g,'').trim();
  return clean(render(template))||clean(render(fallback));
}

/**
 * Greeting templates: `{name}` placeholders plus optional segments like `{, client_first_name}`
 * (prefix kept only when the value is known). A sentence whose plain placeholder is empty is
 * dropped as a whole, so "Это , ассистент ." never reaches the client.
 */
export function renderGreeting(settings:OwnerSettings|undefined,key:string,language:string,values:Record<string,string|null|undefined>):string {
  const defaults=TEMPLATE_DEFAULTS[key];
  if(!defaults)throw new Error('Unknown template');
  const candidate=settings?.templates?.[key]?.[language];
  const template=typeof candidate==='string'&&candidate.trim()?candidate:(defaults[language]??defaults.ru??defaults.en!);
  const value=(k:string)=>String(values[k]??'').replace(/[<>{}]/g,'').trim();
  const withSegments=template.replace(/\{([^a-z{}][^{}]*?)([a-z_]+)\}/g,(_all,prefix:string,k:string)=>value(k)?`${prefix}${value(k)}`:'');
  const sentences=withSegments.split(/(?<=[.!?])\s+/);
  const kept=sentences.filter(sentence=>[...sentence.matchAll(/\{([a-z_]+)\}/g)].every(m=>value(m[1]!)));
  const text=(kept.length?kept:sentences.slice(0,1)).join(' ').replace(/\{([a-z_]+)\}/g,(_all,k:string)=>value(k));
  return text.replace(/\s+([,.!?])/g,'$1').replace(/\s{2,}/g,' ').trim();
}
