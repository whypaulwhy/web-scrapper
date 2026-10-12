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

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol',
  'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'figure', 'figcaption', 'table', 'caption', 'tr', 'td', 'th',
]);

const MAX_CANDIDATES_PER_SELECTOR = 25;
// Real pages are rarely nested more than ~50 levels deep. Anything far beyond this is broken or hostile
// markup that would make CSS selector matching very slow, so it is rejected up front.
const MAX_DOM_DEPTH = 1_000;
const BLOCK_END = Symbol('block-end');

/** Depth of the deepest element in the document, measured iteratively. */
function maxDepth(rootNode) {
  let deepest = 0;
  const stack = [[rootNode, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > deepest) deepest = depth;
    if (deepest > MAX_DOM_DEPTH) break;
    for (const child of node.children || []) {
      if (child.type === 'tag') stack.push([child, depth + 1]);
    }
  }
  return deepest;
}

/**
 * Returns the readable text under a DOM node, with line breaks around block elements and
 * HTML source whitespace collapsed (like a browser renders it). Iterative, so it runs in
 * linear time and can't overflow the stack on deeply nested markup.
 */
function collectText(rootNode) {
  const out = [];
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (node === BLOCK_END) {
      out.push('\n');
    } else if (node.type === 'text') {
      out.push(node.data.replace(/\s+/g, ' '));
    } else if (node.type === 'tag' || node.type === 'root') {
      if (node.name === 'br') {
        out.push('\n');
        continue;
      }
      if (BLOCK_TAGS.has(node.name)) {
        out.push('\n');
        stack.push(BLOCK_END);
      }
      const children = node.children || [];
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
  return out.join('');
}

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
  // htmlparser2 (via `xml: { xmlMode: false }`) parses HTML in linear time; Cheerio's default
  // parse5 parser is spec-exact but slows to tens of seconds on deeply nested or hostile markup.
  const $ = cheerio.load(html, { xml: { xmlMode: false, decodeEntities: true } });
  if (maxDepth($.root().get(0)) > MAX_DOM_DEPTH) {
    throw new ScrapeError("This page's HTML is nested too deeply to process.", 422);
  }

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

  $(`${NOISE_SELECTORS},[style*="display:none"],[style*="display: none"]`).remove();

  let root = null;
  for (const selector of MAIN_CONTENT_SELECTORS) {
    // Pick the largest match for this selector (pages often have several <article>s, e.g. comments).
    // Only the first few matches are measured so pathological pages can't make this quadratic.
    let best = null;
    let bestLength = 0;
    for (const el of $(selector).slice(0, MAX_CANDIDATES_PER_SELECTOR).toArray()) {
      const length = collectText(el).replace(/\s+/g, ' ').trim().length;
      if (length > bestLength) {
        best = el;
        bestLength = length;
      }
    }
    if (best && bestLength >= 200) {
      root = best;
      break;
    }
  }
  if (!root) root = $('body').get(0) || $.root().get(0);

  const siteName = ($('meta[property="og:site_name"]').attr('content') || '').trim();

  return { title, siteName, description, text: cleanLines(collectText(root)) };
}

/**
 * Drops a trailing site name from a page title ("Octopus - Wikipedia" -> "Octopus"),
 * but only when the suffix clearly is the site's name, so real titles are left alone.
 */
export function cleanTitle(title, siteName, hostname) {
  const match = /^(.{4,}?)\s+[-|–—·]\s+([^-|–—·]{2,40})$/.exec(title);
  if (!match) return title;

  const squash = (value) => (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = squash(match[2]);
  if (!suffix) return title;
  if (suffix === squash(siteName) || squash(hostname).includes(suffix)) return match[1].trim();
  return title;
}

/** Scrapes a URL and returns its main text content, ready to be summarized. */
export async function scrapePage(url) {
  const { body, finalUrl, isPlainText } = await fetchPage(url);

  const { title, siteName, description, text } = isPlainText
    ? { title: '', siteName: '', description: '', text: cleanLines(body) }
    : extractContent(body);
  const hostname = new URL(finalUrl).hostname;

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
    title: cleanTitle(title, siteName, hostname) || hostname,
    description,
    text: truncated ? fullText.slice(0, MAX_CONTENT_CHARS) : fullText,
    wordCount,
    truncated,
  };
}
