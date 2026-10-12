import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getProviderConfig, parseSummary, summarizePage } from '../src/summarizer.js';

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
