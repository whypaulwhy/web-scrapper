import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createCache } from './cache.js';
import { normalizeUrl, scrapePage } from './scraper.js';
import { AiError, extractiveSummary, getAttemptPlan, getProviderConfig, summarizePage } from './summarizer.js';

const WORDS_PER_MINUTE = 230;

const FALLBACK_NOTICE =
  "The AI service couldn't be reached just now, so this is the opening of the page instead of a summary. Try again in a minute.";

// Successful summaries are reused for 6 hours so repeat requests don't spend the free AI quota.
export const summaryCache = createCache({
  ttlMs: process.env.SUMMARY_CACHE_TTL_MS !== undefined ? Number(process.env.SUMMARY_CACHE_TTL_MS) : 6 * 60 * 60 * 1000,
  maxEntries: 200,
});

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Behind Vercel / Render proxies, so rate limiting sees the real client IP.

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10kb' }));

const summarizeLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE) || 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.' },
});

app.get('/api/health', (req, res) => {
  const config = getProviderConfig();
  const attempts = getAttemptPlan();
  res.json({
    status: 'ok',
    provider: config.label,
    model: config.model,
    aiConfigured: attempts.length > 0,
    models: attempts.map((attempt) => `${attempt.label}: ${attempt.model}`),
  });
});

app.post('/api/summarize', summarizeLimiter, async (req, res, next) => {
  try {
    const url = normalizeUrl(req.body?.url);

    const cached = summaryCache.get(url.href);
    if (cached) return res.json({ ...cached, cached: true });

    const page = await scrapePage(url);

    let ai;
    try {
      ai = await summarizePage(page);
    } catch (err) {
      // If every AI model failed (quota, outage, bad key...), still give the reader something useful,
      // clearly marked as not being an AI summary. A model refusing the content is reported as-is.
      if (!(err instanceof AiError) || err.code === 'blocked') throw err;
      console.error(`[ai] All models failed (last: ${err.code}); returning an extract instead.`);
      ai = { summary: extractiveSummary(page), keyPoints: [], provider: null, model: null, fallback: true };
    }

    const result = {
      url: page.url,
      title: page.title,
      description: page.description,
      summary: ai.summary,
      keyPoints: ai.keyPoints,
      wordCount: page.wordCount,
      readingTimeMinutes: Math.max(1, Math.round(page.wordCount / WORDS_PER_MINUTE)),
      truncated: page.truncated,
      provider: ai.provider,
      model: ai.model,
      fallback: Boolean(ai.fallback),
      ...(ai.fallback ? { notice: FALLBACK_NOTICE } : {}),
    };

    if (!result.fallback) {
      summaryCache.set(url.href, result);
      if (page.url !== url.href) summaryCache.set(page.url, result);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` });
});

// Central error handler: known errors carry a user-safe message, everything else is logged and hidden.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON, e.g. {"url": "https://example.com"}.' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }

  const status = Number.isInteger(err?.status) ? err.status : 500;
  if (!err?.expose || status >= 500) console.error('[api]', err);

  res.status(status).json({
    error: err?.expose ? err.message : 'Something went wrong on our side. Please try again.',
  });
});

export default app;
