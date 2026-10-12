import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024; // 3 MB of HTML is plenty for an article
const MAX_REDIRECTS = 5;
const MIN_CONTENT_CHARS = 80;

// Upper bound on how much text we send to the AI model (keeps requests fast and inside free-tier limits).
export const MAX_CONTENT_CHARS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 WebScrapperBot/1.0';

// Elements that never contain the main readable content of a page.
const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas',
  'video', 'audio', 'picture', 'form', 'button', 'input', 'select', 'textarea',
  'nav', 'header', 'footer', 'aside', 'menu', 'dialog',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
  '[role="search"]', '[aria-hidden="true"]', '[hidden]',
  '.sr-only', '.visually-hidden', '.cookie-banner', '#cookie-banner', '.advertisement', '.ads',
].join(',');

// Likely containers of the main content, in order of preference.
const MAIN_CONTENT_SELECTORS = [
  'article', 'main', '[role="main"]', '#content', '#main-content', '#main',
  '.post-content', '.entry-content', '.article-body', '.content',
];

const BLOCK_SELECTORS = [
  'p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'dt', 'dd', 'blockquote', 'pre', 'figcaption', 'caption', 'tr', 'td', 'th',
].join(',');

/** Error with an HTTP status and a message that is safe to show to the user. */
export class ScrapeError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'ScrapeError';
    this.status = status;
    this.expose = true;
  }
}

/**
 * Validates user input and turns it into a URL object.
 * Accepts bare domains like "example.com" by assuming https.
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ScrapeError('Please enter a URL to summarize.', 400);
  }

  let raw = input.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ScrapeError("That doesn't look like a valid URL.", 400);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ScrapeError('Only http:// and https:// URLs are supported.', 400);
  }
  if (url.username || url.password) {
    throw new ScrapeError('URLs containing credentials are not supported.', 400);
  }
  if (!url.hostname.includes('.') && !net.isIP(stripBrackets(url.hostname))) {
    throw new ScrapeError("That doesn't look like a valid public website address.", 400);
  }

  url.hash = '';
  return url;
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    if (v.startsWith('::ffff:')) {
      const mapped = v.slice(7);
      // Hex-form mapped addresses (e.g. ::ffff:7f00:1) are blocked outright.
      return net.isIPv4(mapped) ? isPrivateAddress(mapped) : true;
    }
    return /^(fc|fd|fe[89ab]|ff)/.test(v);
  }

  return true; // Not an IP at all: treat as unsafe.
}

function stripBrackets(hostname) {
  return hostname.replace(/^\[|\]$/g, '');
}

/** Blocks requests to localhost / internal networks (SSRF protection). */
async function assertPublicHost(hostname) {
  const host = stripBrackets(hostname).toLowerCase();
  const blockedMessage = 'That URL points to a local or private network address, which is not allowed.';

  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) {
    throw new ScrapeError(blockedMessage, 400);
  }

  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      throw new ScrapeError(`Could not find a website at "${host}". Check the address and try again.`, 422);
    }
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new ScrapeError(blockedMessage, 400);
  }
}

function charsetFrom(contentType) {
  const match = /charset=["']?([^;"'\s]+)/i.exec(contentType || '');
  return match ? match[1] : 'utf-8';
}

/** Reads a response body as text, stopping once MAX_RESPONSE_BYTES have been received. */
async function readBodyLimited(response, contentType) {
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (received < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
  }
  await reader.cancel().catch(() => {});

  const bytes = Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES);
  try {
    return new TextDecoder(charsetFrom(contentType)).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Downloads a page, following redirects manually so every hop is checked against private networks. */
async function fetchPage(startUrl) {
  let url = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url.hostname);

    let response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new ScrapeError('The website took too long to respond. Please try again later.', 504);
      }
      throw new ScrapeError('Could not connect to that website. Check the URL and try again.', 502);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ScrapeError('The website redirected to an unsupported address.', 502);
      }
      continue;
    }

    if (!response.ok) {
      const hint = [401, 403, 429].includes(response.status)
        ? ' The site may be blocking automated requests.'
        : '';
      throw new ScrapeError(`The website responded with HTTP ${response.status}.${hint}`, 502);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      throw new ScrapeError(
        `This URL returns "${contentType.split(';')[0]}", not a webpage. Only HTML pages can be summarized.`,
        415,
      );
    }

    const body = await readBodyLimited(response, contentType);
    return { body, finalUrl: url.href, isPlainText: /text\/plain/i.test(contentType) };
  }

  throw new ScrapeError('The website redirected too many times.', 502);
}

function cleanLines(text) {
  const lines = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length > 1 && line !== lines[lines.length - 1]) lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Extracts the title, description and main readable text from an HTML document.
 * Exported separately so it can be unit tested without network access.
 */
export function extractContent(html) {
  const $ = cheerio.load(html);

  const title = (
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    $('h1').first().text() ||
    ''
  ).replace(/\s+/g, ' ').trim();

  const description = (
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    ''
  ).replace(/\s+/g, ' ').trim();

  $(NOISE_SELECTORS).remove();
  $('[style*="display:none"], [style*="display: none"]').remove();

  let root = null;
  for (const selector of MAIN_CONTENT_SELECTORS) {
    // Pick the largest match for this selector (pages often have several <article>s, e.g. comments).
    let best = null;
    let bestLength = 0;
    $(selector).each((_, el) => {
      const length = $(el).text().replace(/\s+/g, ' ').trim().length;
      if (length > bestLength) {
        best = $(el);
        bestLength = length;
      }
    });
    if (best && bestLength >= 200) {
      root = best;
      break;
    }
  }
  if (!root) root = $('body').length ? $('body') : $.root();

  // Collapse HTML source whitespace (like a browser does), then put line breaks
  // around block elements so their text doesn't run together.
  root.find('*').addBack().contents().each((_, node) => {
    if (node.type === 'text') node.data = node.data.replace(/\s+/g, ' ');
  });
  root.find('br').replaceWith('\n');
  root.find(BLOCK_SELECTORS).each((_, el) => {
    $(el).prepend('\n').append('\n');
  });

  return { title, description, text: cleanLines(root.text()) };
}

/** Scrapes a URL and returns its main text content, ready to be summarized. */
export async function scrapePage(url) {
  const { body, finalUrl, isPlainText } = await fetchPage(url);

  const { title, description, text } = isPlainText
    ? { title: '', description: '', text: cleanLines(body) }
    : extractContent(body);

  if (text.length < MIN_CONTENT_CHARS && description.length < MIN_CONTENT_CHARS) {
    throw new ScrapeError(
      'Could not find enough readable text on this page. It may require JavaScript to render or be behind a login.',
      422,
    );
  }

  const fullText = text.length >= MIN_CONTENT_CHARS ? text : description;
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  const truncated = fullText.length > MAX_CONTENT_CHARS;

  return {
    url: finalUrl,
    title: title || new URL(finalUrl).hostname,
    description,
    text: truncated ? fullText.slice(0, MAX_CONTENT_CHARS) : fullText,
    wordCount,
    truncated,
  };
}
