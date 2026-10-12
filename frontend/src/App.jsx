import { useEffect, useRef, useState } from 'react';
import { summarizeUrl } from './api.js';

const REPO_URL = 'https://github.com/whypaulwhy/web-scrapper';
const RECENT_KEY = 'gist.recent';
const MAX_RECENT = 5;

const EXAMPLES = [
  { label: 'a Wikipedia article', url: 'https://en.wikipedia.org/wiki/Octopus' },
  { label: 'a Paul Graham essay', url: 'https://paulgraham.com/greatwork.html' },
  { label: 'an MDN guide', url: 'https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Scripting/What_is_JavaScript' },
];

function hostnameOf(url) {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function loadRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((item) => item?.url && item?.summary).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecent(items) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    // Storage can be full or blocked (private mode); history is a convenience, so ignore.
  }
}

export default function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [recent, setRecent] = useState(loadRecent);
  const [elapsed, setElapsed] = useState(0);
  const controllerRef = useRef(null);
  const inputRef = useRef(null);

  const isLoading = status === 'loading';
  // The summary on screen isn't repeated in the history list below it.
  const history = recent.filter((item) => !(status === 'done' && item.url === result?.url));

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (!isLoading) return undefined;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isLoading]);

  async function run(target) {
    const trimmed = target.trim();
    if (!trimmed) {
      setStatus('error');
      setError('Paste a link to a webpage first.');
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
      setStatus('done');
      // A page extract shown while the AI is unavailable isn't worth keeping in the history.
      if (data.fallback) return;
      setRecent((items) => {
        const next = [data, ...items.filter((item) => item.url !== data.url)].slice(0, MAX_RECENT);
        saveRecent(next);
        return next;
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message);
      setStatus('error');
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    run(url);
  }

  function tryExample(exampleUrl) {
    setUrl(exampleUrl);
    run(exampleUrl);
  }

  function showRecent(item) {
    controllerRef.current?.abort();
    setUrl(item.url);
    setResult(item);
    setError('');
    setStatus('done');
  }

  function clearRecent() {
    setRecent([]);
    saveRecent([]);
  }

  return (
    <div className="page">
      <header className="masthead">
        <span className="wordmark">Gist</span>
        <a className="quiet-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
          Source on GitHub
        </a>
      </header>

      <main>
        <h1>Get the gist of any webpage.</h1>
        <p className="intro">
          Paste a link to an article, blog post or documentation page. You&rsquo;ll get a short summary of what it
          says and the points worth remembering.
        </p>

        <form className="ask" onSubmit={handleSubmit} noValidate>
          <label htmlFor="url" className="visually-hidden">
            Link to a webpage
          </label>
          <div className={`field${isLoading ? ' is-loading' : ''}`}>
            <input
              id="url"
              ref={inputRef}
              type="url"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="off"
              spellCheck="false"
              placeholder="https://"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              aria-invalid={status === 'error' ? 'true' : undefined}
              aria-describedby={status === 'error' ? 'form-error' : 'examples'}
            />
            <button type="submit" disabled={isLoading}>
              {isLoading ? 'Loading...' : 'Summarize'}
            </button>
          </div>
        </form>

        {status === 'error' && (
          <p id="form-error" className="error" role="alert">
            {error}{' '}
            {url.trim() && (
              <button type="button" className="text-button" onClick={() => run(url)}>
                Try again
              </button>
            )}
          </p>
        )}

        {status === 'idle' && (
          <p id="examples" className="examples">
            Or try{' '}
            {EXAMPLES.map((example, index) => (
              <span key={example.url}>
                <button type="button" className="text-button" onClick={() => tryExample(example.url)}>
                  {example.label}
                </button>
                {index < EXAMPLES.length - 2 ? ', ' : index === EXAMPLES.length - 2 ? ' or ' : '.'}
              </span>
            ))}
          </p>
        )}

        <div aria-live="polite">
          {isLoading && (
            <p className="loading">
              Loading... reading {hostnameOf(url)} and writing a summary.
              {elapsed >= 2 && <span className="elapsed"> {elapsed}s</span>}
              {elapsed >= 12 && <span className="slow"> Slow sites can take up to half a minute.</span>}
            </p>
          )}

          {status === 'done' && result && <Summary result={result} />}
        </div>

        {history.length > 0 && !isLoading && (
          <section className="recent" aria-labelledby="recent-heading">
            <div className="recent-head">
              <h2 id="recent-heading">Recently summarized</h2>
              <button type="button" className="text-button muted" onClick={clearRecent}>
                Clear
              </button>
            </div>
            <ul>
              {history.map((item) => (
                <li key={item.url}>
                  <button type="button" className="recent-item" onClick={() => showRecent(item)}>
                    <span className="recent-title">{item.title}</span>
                    <span className="recent-host">{hostnameOf(item.url)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      <footer className="colophon">
        <p>
          Works best with articles, blog posts and docs. Pages that only load with JavaScript, or sit behind a
        login, usually can&rsquo;t be read. Summaries are written by an AI model and can miss things, so check
          the original before you rely on it.
        </p>
      </footer>
    </div>
  );
}

function Summary({ result }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = [
      result.title,
      result.url,
      '',
      result.summary,
      ...(result.keyPoints.length ? ['', ...result.keyPoints.map((point) => `- ${point}`)] : []),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const minutes = result.readingTimeMinutes;

  return (
    <article className="summary">
      <a className="source" href={result.url} target="_blank" rel="noopener noreferrer">
        {hostnameOf(result.url)}
      </a>
      <h2 className="summary-title">{result.title}</h2>

      {result.fallback && <p className="notice">{result.notice}</p>}

      <p className="summary-text">{result.summary}</p>

      {result.keyPoints.length > 0 && (
        <>
          <h3>The main points</h3>
          <ul className="points">
            {result.keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </>
      )}

      <p className="provenance">
        From {result.wordCount.toLocaleString()} words on the page, about {minutes} {minutes === 1 ? 'minute' : 'minutes'}{' '}
        of reading.
        {!result.fallback && result.truncated && ' The page is long, so only its first part was summarized.'}
        {!result.fallback && ` Summarized by ${result.model}.`}
      </p>

      <div className="actions">
        <button type="button" className="secondary" onClick={copy}>
          {copied ? 'Copied' : 'Copy summary'}
        </button>
        <a className="secondary" href={result.url} target="_blank" rel="noopener noreferrer">
          Open the page
        </a>
      </div>
    </article>
  );
}
