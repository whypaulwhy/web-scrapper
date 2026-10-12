import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractContent, isPrivateAddress, normalizeUrl, ScrapeError } from '../src/scraper.js';

describe('normalizeUrl', () => {
  it('accepts full http(s) URLs', () => {
    assert.equal(normalizeUrl('https://example.com/a?b=1').href, 'https://example.com/a?b=1');
    assert.equal(normalizeUrl('http://example.com').protocol, 'http:');
  });

  it('adds https:// to bare domains and drops the hash', () => {
    assert.equal(normalizeUrl('  example.com/page#section ').href, 'https://example.com/page');
  });

  it('rejects empty, malformed and non-http input', () => {
    for (const input of ['', '   ', undefined, 42, 'not a url', 'ftp://example.com', 'javascript:alert(1)', 'https://user:pw@example.com']) {
      assert.throws(() => normalizeUrl(input), ScrapeError, `expected ${String(input)} to be rejected`);
    }
  });
});

describe('isPrivateAddress', () => {
  it('flags loopback, private and link-local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
});

describe('extractContent', () => {
  const html = `<!doctype html>
    <html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="The Real Title">
      <meta name="description" content="A short description.">
      <style>.x { color: red }</style>
      <script>window.tracking = true;</script>
    </head><body>
      <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
      <aside>Subscribe to our newsletter!</aside>
      <article>
        <h1>Main heading</h1>
        <p>The first paragraph of the article explains the topic in enough detail to be considered real content.</p>
        <p>The second   paragraph
           continues the story with more useful information for the reader.</p>
        <ul><li>First point</li><li>Second point</li></ul>
      </article>
      <footer>Copyright 2026</footer>
    </body></html>`;

  it('reads the title and description from meta tags', () => {
    const { title, description } = extractContent(html);
    assert.equal(title, 'The Real Title');
    assert.equal(description, 'A short description.');
  });

  it('keeps the article text and removes scripts, styles, navigation and footers', () => {
    const { text } = extractContent(html);
    assert.match(text, /Main heading/);
    assert.match(text, /The second paragraph continues the story/);
    assert.match(text, /First point\nSecond point/);
    for (const noise of ['tracking', 'color: red', 'About', 'newsletter', 'Copyright']) {
      assert.doesNotMatch(text, new RegExp(noise), `should not contain "${noise}"`);
    }
  });

  it('falls back to <body> when there is no obvious main container', () => {
    const { title, text } = extractContent('<html><body><h1>Hi</h1><p>Just some text.</p></body></html>');
    assert.equal(title, 'Hi');
    assert.equal(text, 'Hi\nJust some text.');
  });
});
