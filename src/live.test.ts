import { describe, expect, it } from 'vitest';
import { decodoTools } from './index.js';

const apiKey = process.env.DECODO_LIVE_API_KEY;

const run = async <Output>(executable: { execute?: unknown }, input: object): Promise<Output> =>
  (executable.execute as (input: object, options: unknown) => Promise<Output>)(input, {});

describe.skipIf(!apiKey)('live', { timeout: 180_000 }, () => {
  const tools = decodoTools({ apiKey: apiKey || 'skipped' });

  it('scrapes a page', async () => {
    const output = await run<{ content: string }>(tools.scrape, { url: 'https://ip.decodo.com' });

    expect(output.content.length).toBeGreaterThan(0);
  });

  it('turns a rejected key into a readable error', async () => {
    const rejected = decodoTools({ apiKey: 'not-a-real-key' });

    await expect(run(rejected.scrape, { url: 'https://ip.decodo.com' })).rejects.toThrow(/DECODO_API_KEY/);
  });
});
