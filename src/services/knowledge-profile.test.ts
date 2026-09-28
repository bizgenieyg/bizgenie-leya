import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExtraction, quoteInSource, splitForExtraction } from './fact-extraction.service.js';
import { newNumbers, parseAuditItems } from './knowledge-audit.service.js';
import { checkLinkUrl, fetchPublicPage, htmlToText, innerPageLinks, isPrivateAddress } from './link-reader.service.js';
import { factsMarkdown } from './business-facts.service.js';

const source = 'Маникюр с покрытием — 150 ₪.\nПедикюр   — 180 ₪.\nРаботаем вс–чт 9–19, Ришон.';

test('quotes must be verbatim (whitespace-normalised) substrings; facts without one are dropped', () => {
  assert.equal(quoteInSource('Педикюр — 180 ₪', source), true);
  assert.equal(quoteInSource('Педикюр — 200 ₪', source), false);
  assert.equal(quoteInSource('маникюр с покрытием', source), false, 'case is part of the quote');
  const r = parseExtraction(JSON.stringify({ facts: [
    { topic: 'services_prices', text: 'Маникюр с покрытием стоит 150 ₪.', quote: 'Маникюр с покрытием — 150 ₪' },
    { topic: 'services_prices', text: 'Наращивание 250 ₪.', quote: 'Наращивание — 250 ₪' },
    { topic: 'weather', text: 'x', quote: 'Ришон' },
    { topic: 'location_hours', text: 'Ришон, вс–чт 9–19.', quote: '' }],
    conflicts: [{ fact_id: 'f1', new_text: 'Педикюр 180 ₪', quote: 'Педикюр — 180 ₪' }, { fact_id: 'unknown', new_text: 'x', quote: 'Ришон' }],
    gaps: ['booking', 'nonsense'] }), source, [{ id: 'f1', topic: 'services_prices', text: 'Педикюр 160 ₪' }]);
  assert.deepEqual(r.facts.map(f => f.text), ['Маникюр с покрытием стоит 150 ₪.']);
  assert.deepEqual(r.conflicts.map(c => c.fact_id), ['f1']);
  assert.deepEqual(r.gaps, ['booking']);
  assert.equal(r.dropped, 4);
  assert.deepEqual(parseExtraction('not json', source, []).facts, []);
  assert.ok(splitForExtraction('a. '.repeat(20000), 20000).every(p => p.length <= 20000));
});

test('audit suggestions may not add numbers or claims; unknown facts and no-ops are dropped', () => {
  const scope = [{ id: 'f1', topic: 'services_prices', text: 'Гель-лак, комби, аппаратный — 150 ₪.' }] as never;
  const all = ['Гель-лак, комби, аппаратный — 150 ₪.', 'Работаем с 9 до 19.'];
  const raw = JSON.stringify({ items: [
    { check: 'jargon', fact_id: 'f1', suggested: 'Маникюр с покрытием, которое долго держится, — 150 ₪.', reason: 'термины', new_claims: [] },
    { check: 'jargon', fact_id: 'f1', suggested: 'Маникюр, который держится 3 недели, — 150 ₪.', new_claims: [] },
    { check: 'no_benefit', fact_id: 'f1', suggested: 'Маникюр с гарантией.', new_claims: ['гарантия'] },
    { check: 'jargon', fact_id: 'zzz', suggested: 'x', new_claims: [] },
    { check: 'hack', fact_id: 'f1', suggested: 'y', new_claims: [] }] });
  const cards = parseAuditItems(raw, 'services_prices', scope, all);
  assert.deepEqual(cards.map(c => c.suggested_text), ['Маникюр с покрытием, которое долго держится, — 150 ₪.']);
  assert.deepEqual(newNumbers('от 150 ₪ за 3 недели', all), ['3']);
});

test('SSRF guard: private, loopback, link-local, mapped addresses and bad schemes are refused', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as { details?: { code?: string } }).details?.code; } };
  assert.equal(code(() => checkLinkUrl('http://localhost:3000')), 'link_private');
  assert.equal(code(() => checkLinkUrl('http://10.0.0.5/x')), 'link_private');
  assert.equal(code(() => checkLinkUrl('http://169.254.169.254/latest/meta-data')), 'link_private');
  assert.equal(code(() => checkLinkUrl('http://[::1]/')), 'link_private');
  assert.equal(code(() => checkLinkUrl('file:///etc/passwd')), 'link_invalid');
  assert.equal(code(() => checkLinkUrl('https://user:pw@example.com')), 'link_invalid');
  assert.equal(code(() => checkLinkUrl('https://www.instagram.com/salon')), 'link_social');
  assert.equal(code(() => checkLinkUrl('https://salon.example.com')), 'ok');
  // A public page that redirects into the private network is refused at the redirect.
  const fetcher = async (url: URL) => url.hostname === 'salon.example.com' ? { status: 302, location: 'http://127.0.0.1/admin', contentType: '', body: '' } : { status: 200, location: null, contentType: 'text/html', body: 'secret' };
  await assert.rejects(fetchPublicPage('https://salon.example.com', { timeoutMs: 1000, maxBytes: 1000, maxPages: 0 }, fetcher), (e: { details?: { code?: string } }) => e.details?.code === 'link_private');
  // The socket's own DNS answer is checked too (rebinding): a name resolving to loopback fails before connecting.
  await assert.rejects(fetchPublicPage('http://localtest.me', { timeoutMs: 2000, maxBytes: 1000, maxPages: 0 }), (e: { details?: { code?: string } }) => ['link_private', 'link_unavailable'].includes(String(e.details?.code)));
});

test('page text without menus/footer; inner pages of the same site only', () => {
  const html = '<html><head><title>Салон &amp; Ко</title><script>x()</script></head><body><nav><a href="/prices">Цены</a><a href="https://other.com/prices">Цены</a><a href="/blog">Блог</a><a href="/contact">Контакты</a></nav><main><h1>Маникюр</h1><p>150&nbsp;₪</p></main><footer>© 2026</footer></body></html>';
  const page = htmlToText(html);
  assert.equal(page.title, 'Салон & Ко');
  assert.equal(page.text, 'Маникюр\n150 ₪');
  assert.deepEqual(innerPageLinks(html, new URL('https://salon.example.com/'), 5), ['https://salon.example.com/prices', 'https://salon.example.com/contact']);
});

test('profile markdown groups facts by topic in a fixed order', () => {
  assert.equal(factsMarkdown([{ topic: 'booking', text: 'Запись в WhatsApp.' }, { topic: 'services_prices', text: 'Маникюр 150 ₪.' }]),
    '## услуги и цены\n- Маникюр 150 ₪.\n\n## как записаться или начать\n- Запись в WhatsApp.');
});

test('offer topic wording follows the sector: goods, rental, otherwise services (the key stays services_prices)', async () => {
  const { offeringKind } = await import('../config/discovery.js');
  const { offerTopicName } = await import('../config/knowledge-topics.js');
  for (const [sector, kind] of [['магазин одежды', 'goods'], ['интернет-магазин', 'goods'], ['חנות פרחים', 'goods'], ['online shop', 'goods'], ['прокат автомобилей', 'rental'], ['аренда квартир посуточно', 'rental'], ['השכרת רכב', 'rental'], ['car rental', 'rental'],
    ['маникюр', 'services'], ['автоматизация', 'services'], ['домашний повар', 'services'], [null, 'services'], ['', 'services']] as const)
    assert.equal(offeringKind(sector), kind, String(sector));
  assert.equal(offerTopicName('прокат автомобилей'), 'что сдаёте и цены');
  assert.equal(factsMarkdown([{ topic: 'services_prices', text: 'Платье 300 ₪.' }], 'магазин одежды'), '## товары и цены\n- Платье 300 ₪.');
});
