import { describe, expect, it } from 'vitest';
import { decodoTools } from './index.js';

const apiKey = process.env.DECODO_LIVE_API_KEY;

const run = async <Output>(executable: { execute?: unknown }, input: object): Promise<Output> =>
  (executable.execute as (input: object, options: unknown) => Promise<Output>)(input, {});

const POLL_ATTEMPTS = 24;

describe.skipIf(!apiKey)('live', { timeout: 180_000 }, () => {
  const tools = decodoTools({ apiKey: apiKey || 'skipped' });

  it('scrapes a page', async () => {
    const output = await run<{ content: string }>(tools.scrape, { url: 'https://ip.decodo.com' });

    expect(output.content.length).toBeGreaterThan(0);
  });

  it('searches', async () => {
    const output = await run<{ organic?: unknown[] }>(tools.search, { query: 'decodo' });

    expect(output.organic?.length).toBeGreaterThan(0);
  });

  it('maps a site', async () => {
    const output = await run<{ urls: string[] }>(tools.map, { url: 'https://decodo.com', limit: 5 });

    expect(output.urls.length).toBeGreaterThan(0);
  });

  it('crawls a small site through start, status and results', async () => {
    const { crawl_id } = await run<{ crawl_id: string }>(tools.crawl_start, {
      url: 'https://decodo.com',
      limit: 2,
    });

    let status = 'pending';
    for (let attempt = 0; status === 'pending' && attempt < POLL_ATTEMPTS; attempt += 1) {
      ({ status } = await run<{ status: string }>(tools.crawl_status, { crawl_id }));
    }

    expect(status).toBe('done');
    const { pages } = await run<{ pages: { content: string }[] }>(tools.crawl_results, { crawl_id });
    expect(pages.some(({ content }) => content.length > 0)).toBe(true);
  });

  it('cancels a crawl', async () => {
    const { crawl_id } = await run<{ crawl_id: string }>(tools.crawl_start, {
      url: 'https://decodo.com',
      limit: 2,
    });

    const { status } = await run<{ status: string }>(tools.crawl_cancel, { crawl_id });

    expect(status).toBe('cancelled');
    await expect(run(tools.crawl_results, { crawl_id })).resolves.toBeDefined();
  });

  it('turns a rejected key into a readable error', async () => {
    const rejected = decodoTools({ apiKey: 'not-a-real-key' });

    await expect(run(rejected.search, { query: 'decodo' })).rejects.toThrow(/DECODO_API_KEY/);
  });
});
