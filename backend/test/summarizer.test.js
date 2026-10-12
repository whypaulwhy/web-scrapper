import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCache } from '../src/cache.js';
import { extractiveSummary, getAttemptPlan, getProviderConfig, parseSummary, summarizePage } from '../src/summarizer.js';

describe('parseSummary', () => {
  it('parses a clean JSON reply', () => {
    const result = parseSummary('{"summary":"A page about cats.","keyPoints":["Cats sleep a lot.","Cats purr."]}');
    assert.deepEqual(result, { summary: 'A page about cats.', keyPoints: ['Cats sleep a lot.', 'Cats purr.'] });
  });

  it('handles markdown code fences and bullet prefixes', () => {
    const result = parseSummary('```json\n{"summary":"S","keyPoints":["- one","2. two"]}\n```');
    assert.deepEqual(result, { summary: 'S', keyPoints: ['one', 'two'] });
  });

  it('extracts JSON surrounded by extra text', () => {
    assert.equal(parseSummary('Sure! {"summary":"Inside","keyPoints":[]} Hope that helps.').summary, 'Inside');
  });

  it('falls back to plain text when the reply is not JSON', () => {
    assert.deepEqual(parseSummary('Just a plain summary.'), { summary: 'Just a plain summary.', keyPoints: [] });
  });

  it('rejects an empty reply', () => {
    assert.throws(() => parseSummary('   '));
  });
});

describe('getProviderConfig', () => {
  it('defaults to Gemini', () => {
    const config = getProviderConfig({ GEMINI_API_KEY: 'g' });
    assert.equal(config.id, 'gemini');
    assert.equal(config.apiKey, 'g');
  });

  it('uses Groq when only a Groq key is set', () => {
    assert.equal(getProviderConfig({ GROQ_API_KEY: 'q' }).id, 'groq');
  });

  it('respects AI_PROVIDER and model overrides', () => {
    const config = getProviderConfig({ AI_PROVIDER: 'groq', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', GROQ_MODEL: 'custom' });
    assert.equal(config.id, 'groq');
    assert.equal(config.model, 'custom');
  });
});

describe('summarizePage', () => {
  it('fails clearly when no API key is configured', async () => {
    await assert.rejects(
      summarizePage({ title: 't', url: 'https://example.com', text: 'x' }, {}),
      /missing API key/,
    );
  });
});

describe('getAttemptPlan', () => {
  it('tries the Gemini model, then the Gemini fallbacks, then Groq', () => {
    const plan = getAttemptPlan({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' }).map((a) => `${a.id}:${a.model}`);
    assert.deepEqual(plan, [
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.1-flash-lite',
      'gemini:gemini-3.6-flash',
      'groq:llama-3.3-70b-versatile',
    ]);
  });

  it('puts Groq first when AI_PROVIDER=groq', () => {
    const plan = getAttemptPlan({ AI_PROVIDER: 'groq', GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
    assert.equal(plan[0].id, 'groq');
  });

  it('honours custom fallback lists, including an empty one', () => {
    assert.deepEqual(
      getAttemptPlan({ GEMINI_API_KEY: 'g', GEMINI_MODEL: 'a', GEMINI_FALLBACK_MODELS: 'b, a ,c' }).map((a) => a.model),
      ['a', 'b', 'c'],
    );
    assert.equal(getAttemptPlan({ GEMINI_API_KEY: 'g', GEMINI_FALLBACK_MODELS: '' }).length, 1);
  });

  it('is empty without any key', () => {
    assert.deepEqual(getAttemptPlan({}), []);
  });
});

describe('extractiveSummary', () => {
  it('uses the opening sentences of real paragraphs, skipping short lines', () => {
    const text = 'Menu\nHome\nThe first real sentence of the article is right here. The second one follows it closely. A third sentence ends the paragraph. A fourth is not needed.';
    assert.equal(
      extractiveSummary({ description: '', text }),
      'The first real sentence of the article is right here. The second one follows it closely. A third sentence ends the paragraph.',
    );
  });

  it('falls back to the raw text when nothing looks like a sentence', () => {
    assert.equal(extractiveSummary({ description: '', text: 'just a few words' }), 'just a few words');
  });
});

describe('createCache', () => {
  it('expires entries and evicts the oldest when full', async () => {
    const cache = createCache({ ttlMs: 20, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('c'), 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cache.get('c'), undefined);
  });

  it('stores nothing when the TTL is zero', () => {
    const cache = createCache({ ttlMs: 0, maxEntries: 2 });
    cache.set('a', 1);
    assert.equal(cache.size, 0);
  });
});
