import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { HttpError } from '../utils/http-error.js';

/**
 * Reads a business website for "Добавить что угодно" (task R) on the backend: http/https only, no private,
 * loopback or link-local addresses — checked on every DNS answer the socket actually uses (so DNS rebinding
 * cannot slip through) and on every redirect —, a timeout and a size cap. Social networks are not parsed.
 */
export interface LinkLimits { timeoutMs: number; maxBytes: number; maxPages: number }
export interface LinkPage { url: string; title: string; text: string }

const SOCIAL = /(^|\.)(instagram\.com|facebook\.com|fb\.com|fb\.me|tiktok\.com|threads\.net|x\.com|twitter\.com|linkedin\.com)$/i;
const MAX_REDIRECTS = 5;

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
/** Loopback, private, link-local, CGNAT, multicast and reserved addresses (IPv4, IPv6, IPv4-mapped IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(v) === 4) return ipv4Private(v);
  if (isIP(v) !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1]!);
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
}

/** The URL a link may be fetched from, or an error code. */
export function checkLinkUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new HttpError(400, 'Invalid link', { code: 'link_invalid' }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Invalid link', { code: 'link_invalid' });
  if (url.username || url.password) throw new HttpError(400, 'Invalid link', { code: 'link_invalid' });
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (SOCIAL.test(host)) throw new HttpError(422, 'Social links are not read', { code: 'link_social' });
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host))
    throw new HttpError(400, 'Private address', { code: 'link_private' });
  if (isIP(host) && isPrivateAddress(host)) throw new HttpError(400, 'Private address', { code: 'link_private' });
  return url;
}

/** DNS lookup that refuses private answers: used by the socket itself, so the checked address is the connected one. */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return (callback as (e: NodeJS.ErrnoException | null, a: string, f?: number) => void)(error, '', 0);
    const list = (addresses as unknown as LookupAddress[]);
    if (!list.length || list.some(a => isPrivateAddress(a.address))) {
      const denied = Object.assign(new Error('private address'), { code: 'LINK_PRIVATE' });
      return (callback as (e: NodeJS.ErrnoException | null, a: string, f?: number) => void)(denied, '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    return (callback as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
  });
};

type Fetched = { status: number; location: string | null; contentType: string; body: string };
function fetchOnce(url: URL, limits: LinkLimits): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', lookup: safeLookup, timeout: limits.timeoutMs,
      headers: { 'User-Agent': 'LeyaBot/1.0 (+business profile import)', Accept: 'text/html,text/plain;q=0.9' },
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { response.resume(); resolve({ status, location: response.headers.location ?? null, contentType: '', body: '' }); return; }
      const contentType = String(response.headers['content-type'] ?? '');
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.maxBytes) { request.destroy(Object.assign(new Error('too large'), { code: 'LINK_TOO_LARGE' })); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, location: null, contentType, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    const deadline = setTimeout(() => request.destroy(Object.assign(new Error('timeout'), { code: 'LINK_TIMEOUT' })), limits.timeoutMs);
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'LINK_TIMEOUT' })));
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
    request.end();
  });
}

/** GET with redirects re-validated one by one (a public page may not redirect into the private network). */
export async function fetchPublicPage(raw: string, limits: LinkLimits, fetcher: typeof fetchOnce = fetchOnce): Promise<{ url: URL; contentType: string; body: string }> {
  let url = checkLinkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let result: Fetched;
    try { result = await fetcher(url, limits); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'LINK_PRIVATE') throw new HttpError(400, 'Private address', { code: 'link_private' });
      if (code === 'LINK_TOO_LARGE') throw new HttpError(413, 'Page too large', { code: 'link_too_large' });
      if (code === 'LINK_TIMEOUT') throw new HttpError(504, 'Link timeout', { code: 'link_timeout' });
      throw new HttpError(502, 'Link unavailable', { code: 'link_unavailable' });
    }
    if (result.location) { url = checkLinkUrl(new URL(result.location, url).toString()); continue; }
    if (result.status < 200 || result.status >= 300) throw new HttpError(502, 'Link unavailable', { code: 'link_unavailable' });
    if (!/text\/html|text\/plain|application\/xhtml/i.test(result.contentType)) throw new HttpError(415, 'Not a web page', { code: 'link_not_html' });
    return { url, contentType: result.contentType, body: result.body };
  }
  throw new HttpError(502, 'Too many redirects', { code: 'link_unavailable' });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—', shekel: '₪' };
const decode = (text: string) => text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, entity: string) => {
  if (entity[0] === '#') { const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10); return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''; }
  return ENTITIES[entity.toLowerCase()] ?? all;
});

/**
 * Main text of a page without menus, header, footer, scripts or forms. A small dependency-free reader
 * instead of Readability + jsdom: small-business sites are simple, and the heavy DOM stack is not worth
 * it on the VPS. Prefers <main>/<article> when the page has them.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select'])
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1];
  const text = decode((main ?? body)
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|li|tr|h[1-6]|dd|dt|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

const INNER_PAGE = /цен|прайс|услуг|товар|каталог|магазин|аренд|контакт|о нас|about|price|pricing|service|product|shop|catalog|store|rent|contact|מחיר|שירות|מוצרים|קטלוג|חנות|השכרה|צור קשר|אודות/i;
/** Same-site links whose text or path look like prices, services, contacts or "about". */
export function innerPageLinks(html: string, base: URL, max: number): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (out.length >= max) break;
    const label = decode(match[2]!.replace(/<[^>]+>/g, ' ')).trim();
    let target: URL;
    try { target = new URL(decode(match[1]!), base); } catch { continue; }
    target.hash = '';
    if (target.hostname !== base.hostname || !/^https?:$/.test(target.protocol) || target.toString() === base.toString()) continue;
    if (!INNER_PAGE.test(label) && !INNER_PAGE.test(decodeURIComponent(target.pathname))) continue;
    if (!out.includes(target.toString())) out.push(target.toString());
  }
  return out;
}

/** Main page plus up to `maxPages` inner pages (prices, services, contacts, about) of the same site. */
export async function readLink(raw: string, limits: LinkLimits, fetcher?: Parameters<typeof fetchPublicPage>[2]): Promise<{ title: string; pages: LinkPage[] }> {
  const first = await fetchPublicPage(raw, limits, fetcher);
  const main = /html/i.test(first.contentType) ? htmlToText(first.body) : { title: '', text: first.body.trim() };
  const pages: LinkPage[] = [{ url: first.url.toString(), title: main.title, text: main.text }];
  for (const link of /html/i.test(first.contentType) ? innerPageLinks(first.body, first.url, limits.maxPages) : []) {
    try {
      const page = await fetchPublicPage(link, limits, fetcher);
      const parsed = /html/i.test(page.contentType) ? htmlToText(page.body) : { title: '', text: page.body.trim() };
      if (parsed.text) pages.push({ url: page.url.toString(), title: parsed.title, text: parsed.text });
    } catch { /* an inner page that fails is skipped; the main page is enough */ }
  }
  if (!pages.some(page => page.text.length >= 40)) throw new HttpError(422, 'Page has no readable text', { code: 'link_empty' });
  return { title: main.title, pages };
}
