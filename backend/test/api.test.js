// End-to-end tests for POST /api/summarize covering worst-case inputs, hostile URLs,
// misbehaving websites and AI failures. Outbound network calls (DNS, websites, Gemini) are mocked.
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

process.env.GEMINI_API_KEY = 'test-key';
process.env.RATE_LIMIT_PER_MINUTE = '10000';
delete process.env.GEMINI_MODEL;
delete process.env.GEMINI_FALLBACK_MODELS;
delete process.env.SUMMARY_CACHE_TTL_MS;
delete process.env.GROQ_API_KEY;
delete process.env.AI_PROVIDER;

const { default: app, summaryCache } = await import('../src/app.js');

const realFetch = globalThis.fetch;
const PUBLIC_IP = '93.184.216.34';
const DNS_OVERRIDES = { 'intranet.test': '10.0.0.5', 'sneaky.test': '127.0.0.1' };
const ARTICLE = `<!doctype html><html><head><title>Test article</title></head><body>
  <nav>Home About Contact</nav>
  <article><h1>Test article</h1><p>${'This is a sentence of real article content. '.repeat(30)}</p></article>
</body></html>`;

let server;
let base;
let pages; // Map<href, (init) => Response>
let aiHandler; // (requestBody, model) => Response
let lastAiRequest;
let aiModelsCalled; // models requested from the AI API, in order

const html = (body, status = 200, type = 'text/html; charset=utf-8') =>
  new Response(body, { status, headers: { 'content-type': type } });
const redirect = (location) => new Response(null, { status: 302, headers: { location } });
const gemini = (text) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });

before(async () => {
  mock.method(dns, 'lookup', async (host) => [{ address: DNS_OVERRIDES[host] || PUBLIC_IP, family: 4 }]);
  mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === base) return realFetch(input, init);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      lastAiRequest = JSON.parse(init.body);
      const model = decodeURIComponent(url.pathname.split('/models/')[1].split(':')[0]);
      aiModelsCalled.push(model);
      return aiHandler(lastAiRequest, model);
    }
    const page = pages.get(url.href);
    return page ? page(init) : html('<h1>Not found</h1>', 404);
  });

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  mock.restoreAll();
});

beforeEach(() => {
  pages = new Map([['https://site.test/article', () => html(ARTICLE)]]);
  aiHandler = () => gemini('{"summary":"A test summary.","keyPoints":["One","Two","Three"]}');
  lastAiRequest = null;
  aiModelsCalled = [];
  summaryCache.clear();
});

async function summarize(body, contentType = 'application/json') {
  const response = await realFetch(`${base}/api/summarize`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('happy path', () => {
  it('scrapes the page and returns the AI summary', async () => {
    const { status, body } = await summarize({ url: 'https://site.test/article' });
    assert.equal(status, 200);
    assert.equal(body.title, 'Test article');
    assert.equal(body.summary, 'A test summary.');
    assert.deepEqual(body.keyPoints, ['One', 'Two', 'Three']);
    assert.ok(body.wordCount > 200);
    assert.equal(body.truncated, false);
  });

  it('accepts a bare domain without https://', async () => {
    const { status, body } = await summarize({ url: '  site.test/article  ' });
    assert.equal(status, 200);
    assert.equal(body.url, 'https://site.test/article');
  });

  it('does not send navigation text to the AI', async () => {
    await summarize({ url: 'https://site.test/article' });
    const prompt = lastAiRequest.contents[0].parts[0].text;
    assert.match(prompt, /real article content/);
    assert.doesNotMatch(prompt, /Home About Contact/);
  });
});

describe('bad input', () => {
  const cases = [
    ['missing url', {}],
    ['empty string', { url: '' }],
    ['whitespace', { url: '   ' }],
    ['array', { url: ['https://site.test/article'] }],
    ['object', { url: { href: 'https://site.test/article' } }],
    ['number', { url: 12345 }],
    ['not a url', { url: 'hello world' }],
    ['javascript: scheme', { url: 'javascript:alert(1)' }],
    ['file: scheme', { url: 'file:///etc/passwd' }],
    ['ftp: scheme', { url: 'ftp://site.test/file' }],
    ['data: scheme', { url: 'data:text/html,<h1>hi</h1>' }],
    ['credentials in url', { url: 'https://admin:secret@site.test/' }],
  ];
  for (const [name, payload] of cases) {
    it(`rejects ${name} with 400`, async () => {
      const { status, body } = await summarize(payload);
      assert.equal(status, 400);
      assert.equal(typeof body.error, 'string');
    });
  }

  it('rejects malformed JSON with 400', async () => {
    const { status, body } = await summarize('{"url": ');
    assert.equal(status, 400);
    assert.match(body.error, /valid JSON/);
  });

  it('rejects a non-JSON body with 400', async () => {
    const { status } = await summarize('url=https://site.test/article', 'application/x-www-form-urlencoded');
    assert.equal(status, 400);
  });

  it('rejects an oversized body with 413', async () => {
    const { status } = await summarize({ url: `https://site.test/${'a'.repeat(20_000)}` });
    assert.equal(status, 413);
  });
});

describe('SSRF protection', () => {
  const blocked = [
    'http://localhost:3000',
    'http://127.0.0.1/',
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://0x7f.0.0.1/', // hex form of 127.0.0.1
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
    'http://192.168.1.1/',
    'http://10.0.0.1/',
    'http://intranet.test/', // public-looking name that resolves to 10.0.0.5
    'http://sneaky.test/', // resolves to 127.0.0.1
    'http://printer.local/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, async () => {
      const { status, body } = await summarize({ url });
      assert.equal(status, 400, body.error);
    });
  }

  it('blocks a public page that redirects to a private address', async () => {
    pages.set('https://site.test/redirect', () => redirect('http://169.254.169.254/latest/meta-data/'));
    const { status, body } = await summarize({ url: 'https://site.test/redirect' });
    assert.equal(status, 400);
    assert.match(body.error, /private network/);
  });

  it('follows a normal redirect to another public page', async () => {
    pages.set('https://site.test/old', () => redirect('/article'));
    const { status, body } = await summarize({ url: 'https://site.test/old' });
    assert.equal(status, 200);
    assert.equal(body.url, 'https://site.test/article');
  });
});

describe('misbehaving websites', () => {
  it('stops after too many redirects', async () => {
    pages.set('https://site.test/loop', () => redirect('https://site.test/loop'));
    const { status, body } = await summarize({ url: 'https://site.test/loop' });
    assert.equal(status, 502);
    assert.match(body.error, /redirected too many times/);
  });

  it('reports HTTP errors from the site', async () => {
    const { status, body } = await summarize({ url: 'https://site.test/missing' });
    assert.equal(status, 502);
    assert.match(body.error, /HTTP 404/);
  });

  it('explains when a site blocks bots', async () => {
    pages.set('https://site.test/blocked', () => html('Forbidden', 403));
    const { body } = await summarize({ url: 'https://site.test/blocked' });
    assert.match(body.error, /blocking automated requests/);
  });

  for (const type of ['image/png', 'application/pdf', 'application/json', 'video/mp4']) {
    it(`rejects ${type} content with 415`, async () => {
      pages.set('https://site.test/file', () => html('binary', 200, type));
      const { status } = await summarize({ url: 'https://site.test/file' });
      assert.equal(status, 415);
    });
  }

  it('explains when a JavaScript-only page has no readable text', async () => {
    pages.set('https://site.test/spa', () => html('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'));
    const { status, body } = await summarize({ url: 'https://site.test/spa' });
    assert.equal(status, 422);
    assert.match(body.error, /JavaScript/);
  });

  it('handles an empty response body', async () => {
    pages.set('https://site.test/empty', () => html(''));
    const { status } = await summarize({ url: 'https://site.test/empty' });
    assert.equal(status, 422);
  });

  it('reports a connection failure', async () => {
    pages.set('https://site.test/down', () => {
      throw new TypeError('fetch failed');
    });
    const { status, body } = await summarize({ url: 'https://site.test/down' });
    assert.equal(status, 502);
    assert.match(body.error, /Could not connect/);
  });

  it('reports a timeout', async () => {
    pages.set('https://site.test/slow', () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    const { status, body } = await summarize({ url: 'https://site.test/slow' });
    assert.equal(status, 504);
    assert.match(body.error, /too long/);
  });

  it('reports an unknown domain', async () => {
    dns.lookup.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    const { status, body } = await summarize({ url: 'https://no-such-site.test/' });
    assert.equal(status, 422);
    assert.match(body.error, /Could not find a website/);
  });

  it('handles a huge (6 MB) page quickly and truncates it before sending it to the AI', async () => {
    const paragraphs = Array.from({ length: 100_000 }, (_, i) => `<p>Paragraph ${i} of a very long page with words.</p>`);
    const huge = `<html><body><article>${paragraphs.join('')}</article></body></html>`;
    pages.set('https://site.test/huge', () => html(huge));
    const started = Date.now();
    const { status, body } = await summarize({ url: 'https://site.test/huge' });
    assert.equal(status, 200);
    assert.equal(body.truncated, true);
    assert.ok(lastAiRequest.contents[0].parts[0].text.length < 17_000);
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  });

  it('handles normally nested HTML (200 levels deep)', async () => {
    const nested = `<html><body>${'<div>'.repeat(200)}${'Nested but readable text. '.repeat(10)}${'</div>'.repeat(200)}</body></html>`;
    pages.set('https://site.test/nested', () => html(nested));
    const { status } = await summarize({ url: 'https://site.test/nested' });
    assert.equal(status, 200);
  });

  it('rejects absurdly nested HTML (50,000 levels) quickly instead of hanging', async () => {
    const depth = 50_000;
    const nested = `<html><body>${'<div>'.repeat(depth)}${'Deeply nested text. '.repeat(10)}${'</div>'.repeat(depth)}</body></html>`;
    pages.set('https://site.test/deep', () => html(nested));
    const started = Date.now();
    const { status, body } = await summarize({ url: 'https://site.test/deep' });
    assert.equal(status, 422);
    assert.match(body.error, /nested too deeply/);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  });

  it('decodes non-UTF-8 pages using the declared charset', async () => {
    const bytes = Buffer.from(`<html><head><title>Café crème</title></head><body><p>${'Un café très bon. '.repeat(20)}</p></body></html>`, 'latin1');
    pages.set('https://site.test/latin1', () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=windows-1252' } }));
    const { status, body } = await summarize({ url: 'https://site.test/latin1' });
    assert.equal(status, 200);
    assert.equal(body.title, 'Café crème');
  });

  it('survives an unknown charset label', async () => {
    pages.set('https://site.test/weird', () => html(ARTICLE, 200, 'text/html; charset=made-up-charset'));
    const { status } = await summarize({ url: 'https://site.test/weird' });
    assert.equal(status, 200);
  });

  it('handles broken, unclosed HTML', async () => {
    pages.set('https://site.test/broken', () => html(`<html><body><div><p>${'Unclosed tags everywhere but still readable text. '.repeat(10)}<div><span><b>`));
    const { status } = await summarize({ url: 'https://site.test/broken' });
    assert.equal(status, 200);
  });

  it('summarizes plain-text documents', async () => {
    pages.set('https://site.test/notes.txt', () => html('Plain text notes that are long enough to summarize. '.repeat(10), 200, 'text/plain'));
    const { status } = await summarize({ url: 'https://site.test/notes.txt' });
    assert.equal(status, 200);
  });
});

describe('AI failures and fallbacks', () => {
  const errorReply = (status, message) => () => Response.json({ error: { message } }, { status });
  const ARTICLE_URL = 'https://site.test/article';

  async function expectExtractFallback() {
    const { status, body } = await summarize({ url: ARTICLE_URL });
    assert.equal(status, 200);
    assert.equal(body.fallback, true);
    assert.match(body.notice, /instead of a summary/);
    assert.match(body.summary, /real article content/);
    assert.equal(body.model, null);
    return body;
  }

  it('falls back to the next Gemini model when the first is rate-limited', async () => {
    aiHandler = (_, model) =>
      model === 'gemini-3.5-flash-lite'
        ? errorReply(429, 'Resource has been exhausted')()
        : gemini('{"summary":"From the backup model.","keyPoints":[]}');
    const { status, body } = await summarize({ url: ARTICLE_URL });
    assert.equal(status, 200);
    assert.equal(body.summary, 'From the backup model.');
    assert.equal(body.model, 'gemini-3.1-flash-lite');
    assert.equal(body.fallback, false);
    assert.deepEqual(aiModelsCalled, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  });

  it('skips a model that no longer exists', async () => {
    aiHandler = (_, model) =>
      model === 'gemini-3.5-flash-lite' ? errorReply(404, 'models/x is not found')() : gemini('{"summary":"OK","keyPoints":[]}');
    const { body } = await summarize({ url: ARTICLE_URL });
    assert.equal(body.model, 'gemini-3.1-flash-lite');
  });

  it('tries every model, then returns a labelled extract when the quota is exhausted everywhere', async () => {
    aiHandler = errorReply(429, 'Resource has been exhausted');
    await expectExtractFallback();
    assert.deepEqual(aiModelsCalled, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash']);
  });

  it('stops retrying Gemini after an invalid key, without leaking the key', async () => {
    aiHandler = errorReply(400, 'API key not valid. Please pass a valid API key.');
    const body = await expectExtractFallback();
    assert.equal(aiModelsCalled.length, 1);
    assert.doesNotMatch(JSON.stringify(body), /test-key/);
  });

  it('switches to Groq when Gemini is down and a Groq key is set', async () => {
    process.env.GROQ_API_KEY = 'groq-test-key';
    try {
      aiHandler = errorReply(503, 'overloaded');
      pages.set('https://api.groq.com/openai/v1/chat/completions', () =>
        Response.json({ choices: [{ message: { content: '{"summary":"From Groq.","keyPoints":["a"]}' } }] }),
      );
      const { status, body } = await summarize({ url: ARTICLE_URL });
      assert.equal(status, 200);
      assert.equal(body.provider, 'Groq');
      assert.equal(body.summary, 'From Groq.');
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });

  it('returns an extract during an AI outage (HTML error page)', async () => {
    aiHandler = () => new Response('<html>Service Unavailable</html>', { status: 503 });
    await expectExtractFallback();
  });

  it('returns an extract when the AI times out', async () => {
    aiHandler = () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    await expectExtractFallback();
  });

  it('returns an extract when the AI keeps sending empty replies', async () => {
    aiHandler = () => Response.json({ candidates: [] });
    await expectExtractFallback();
  });

  it('returns an extract when no API key is configured at all', async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expectExtractFallback();
      assert.equal(aiModelsCalled.length, 0);
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });

  it('prefers the meta description for the extract when the page has a good one', async () => {
    const description = 'A carefully written description of this page that is long enough to stand in for a summary.';
    pages.set('https://site.test/described', () =>
      html(ARTICLE.replace('<title>', `<meta name="description" content="${description}"><title>`)),
    );
    aiHandler = errorReply(429, 'exhausted');
    const { body } = await summarize({ url: 'https://site.test/described' });
    assert.equal(body.summary, description);
  });

  it('reports content the AI refused to summarize instead of falling back', async () => {
    aiHandler = () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } });
    const { status } = await summarize({ url: ARTICLE_URL });
    assert.equal(status, 422);
  });

  it('still shows a reply that is not valid JSON', async () => {
    aiHandler = () => gemini('This page is about testing.');
    const { status, body } = await summarize({ url: ARTICLE_URL });
    assert.equal(status, 200);
    assert.equal(body.summary, 'This page is about testing.');
    assert.deepEqual(body.keyPoints, []);
  });
});

describe('caching', () => {
  it('reuses a successful summary instead of calling the AI again', async () => {
    const first = await summarize({ url: 'https://site.test/article' });
    const second = await summarize({ url: 'site.test/article' });
    assert.equal(first.body.cached, undefined);
    assert.equal(second.body.cached, true);
    assert.equal(second.body.summary, first.body.summary);
    assert.equal(aiModelsCalled.length, 1);
  });

  it('does not cache extracts, so the next request tries the AI again', async () => {
    aiHandler = () => Response.json({ error: { message: 'exhausted' } }, { status: 429 });
    await summarize({ url: 'https://site.test/article' });
    aiHandler = () => gemini('{"summary":"Back online.","keyPoints":[]}');
    const { body } = await summarize({ url: 'https://site.test/article' });
    assert.equal(body.summary, 'Back online.');
    assert.equal(body.fallback, false);
  });
});

describe('other routes', () => {
  it('reports health and whether the AI key is configured', async () => {
    const body = await (await realFetch(`${base}/api/health`)).json();
    assert.equal(body.status, 'ok');
    assert.equal(body.aiConfigured, true);
    assert.deepEqual(body.models, ['Google Gemini: gemini-3.5-flash-lite', 'Google Gemini: gemini-3.1-flash-lite', 'Google Gemini: gemini-3.6-flash']);
    assert.doesNotMatch(JSON.stringify(body), /test-key/);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const response = await realFetch(`${base}/api/does-not-exist`);
    assert.equal(response.status, 404);
    assert.ok((await response.json()).error);
  });
});
