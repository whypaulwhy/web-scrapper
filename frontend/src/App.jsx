import { useEffect, useRef, useState } from 'react';
import { summarizeUrl } from './api.js';

const EXAMPLES = [
  { label: 'Wikipedia: Web scraping', url: 'https://en.wikipedia.org/wiki/Web_scraping' },
  { label: 'Paul Graham: How to Do Great Work', url: 'https://paulgraham.com/greatwork.html' },
  { label: 'MDN: What is JavaScript?', url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Scripting/What_is_JavaScript' },
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function runSummary(targetUrl) {
    const trimmed = targetUrl.trim();
    if (!trimmed) {
      setStatus('error');
      setError('Please paste a URL first.');
      inputRef.current?.focus();
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus('loading');
    setError('');
    setResult(null);

    try {
      const data = await summarizeUrl(trimmed, controller.signal);
      setResult(data);
      setStatus('success');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message);
      setStatus('error');
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    runSummary(url);
  }

  function handleExample(exampleUrl) {
    setUrl(exampleUrl);
    runSummary(exampleUrl);
  }

  const isLoading = status === 'loading';

  return (
    <div className="page">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18">
              <path d="M5 7h14M5 12h14M5 17h9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
            </svg>
          </span>
          AI Web Scraper
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <h1>Summarize any webpage</h1>
          <p className="lede">
            Paste a link to an article, blog post or documentation page. The server scrapes its text and an AI
            model writes a short summary.
          </p>
        </section>

        <form className="search" onSubmit={handleSubmit} noValidate>
          <label htmlFor="url-input" className="visually-hidden">
            Webpage URL
          </label>
          <input
            id="url-input"
            ref={inputRef}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck="false"
            placeholder="https://example.com/article"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={isLoading}
            aria-describedby="url-hint"
          />
          <button type="submit" className="primary" disabled={isLoading}>
            {isLoading ? (
              <>
                <span className="spinner" aria-hidden="true" /> Loading...
              </>
            ) : (
              'Summarize'
            )}
          </button>
        </form>

        <div id="url-hint" className="examples">
          <span>Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.url}
              type="button"
              className="chip"
              onClick={() => handleExample(example.url)}
              disabled={isLoading}
            >
              {example.label}
            </button>
          ))}
        </div>

        <section className="output" aria-live="polite" aria-busy={isLoading}>
          {isLoading && <LoadingCard />}
          {status === 'error' && <ErrorCard message={error} onRetry={url.trim() ? () => runSummary(url) : null} />}
          {status === 'success' && result && <SummaryCard result={result} />}
        </section>
      </main>

      <footer className="site-footer">
        Built with React, Express and a free AI API. Only basic HTML pages are supported; sites that need
        JavaScript to render or block bots may fail.
      </footer>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="card loading-card">
      <p className="loading-text">
        <span className="spinner" aria-hidden="true" /> Loading... scraping the page and generating a summary.
      </p>
      <div className="skeleton" style={{ width: '60%' }} />
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton" style={{ width: '80%' }} />
    </div>
  );
}

function ErrorCard({ message, onRetry }) {
  return (
    <div className="card error-card" role="alert">
      <div>
        <h2>Couldn&apos;t summarize this page</h2>
        <p>{message}</p>
      </div>
      {onRetry && (
        <button type="button" className="secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

function SummaryCard({ result }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = [
      result.title,
      result.url,
      '',
      result.summary,
      '',
      ...result.keyPoints.map((point) => `- ${point}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="card summary-card">
      <div className="summary-head">
        <div className="summary-title">
          <a className="source" href={result.url} target="_blank" rel="noopener noreferrer">
            {hostnameOf(result.url)} ↗
          </a>
          <h2>{result.title}</h2>
        </div>
        <button type="button" className="secondary" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <dl className="meta">
        <div>
          <dt>Words scraped</dt>
          <dd>{result.wordCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Reading time</dt>
          <dd>{result.readingTimeMinutes} min</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd title={result.provider}>{result.model}</dd>
        </div>
      </dl>

      <h3>Summary</h3>
      <p className="summary-text">{result.summary}</p>

      {result.keyPoints.length > 0 && (
        <>
          <h3>Key points</h3>
          <ul className="key-points">
            {result.keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </>
      )}

      {result.truncated && (
        <p className="note">This page is long, so only the first part of its text was summarized.</p>
      )}
    </article>
  );
}
