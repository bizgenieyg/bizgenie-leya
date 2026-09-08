import { TEMPLATE_DEFAULTS } from '../config/templates.js';
import type { OwnerSettings } from './owner-settings.service.js';
export const languageOf=(text:string):string=>/[א-ת]/.test(text)?'he':/[а-яё]/i.test(text)?'ru':'en';
export function renderText(settings:OwnerSettings|undefined,key:string,language:string,values:Record<string,string|number>={}):string {
  const defaults=TEMPLATE_DEFAULTS[key];
  if(!defaults)throw new Error('Unknown template');
  const fallback=defaults[language]??defaults.ru??defaults.en!;
  const candidate=settings?.templates?.[key]?.[language];
  const template=typeof candidate==='string'?candidate:fallback;
  const render=(v:string)=>v.replace(/\{([a-z_]+)\}/g,(_all,k:string)=>String(values[k]??''));
  const clean=(v:string)=>v.replace(/<[^>]*>/g,'').replace(/[<>{}]/g,'').trim();
  return clean(render(template))||clean(render(fallback));
}
