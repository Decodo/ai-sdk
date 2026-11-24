import { generateText, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { decodoTools } from './index.js';

const API_KEY = 'test-key';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn<typeof fetch>();

const lastRequest = () => {
  const [url, init] = fetchMock.mock.lastCall as [string, RequestInit];
  return {
    url: new URL(url),
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
};

const run = async <Input, Output>(
  executable: { execute?: unknown },
  input: Input,
): Promise<Output> =>
  (executable.execute as (input: Input, options: unknown) => Promise<Output>)(input, {});

const crawlPage = (url: string, content?: string) => ({
  url,
  content,
  depth: 0,
  status: 'done',
  created_at: '',
  updated_at: '',
  crawl_status: '',
  results_tasks: '',
  results_content: '',
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('decodoTools', () => {
  it('returns the seven tools', () => {
    expect(Object.keys(decodoTools({ apiKey: API_KEY })).sort()).toEqual([
      'crawl_cancel',
      'crawl_results',
      'crawl_start',
      'crawl_status',
      'map',
      'scrape',
      'search',
    ]);
  });

  it('falls back to DECODO_API_KEY', async () => {
    vi.stubEnv('DECODO_API_KEY', 'env-key');
    fetchMock.mockResolvedValue(jsonResponse({ status: 'done' }));

    await run(decodoTools().crawl_status, { crawl_id: 'c1' });

    expect(lastRequest().headers.Authorization).toBe('Bearer env-key');
  });

  it('names DECODO_API_KEY when no key is available', () => {
    vi.stubEnv('DECODO_API_KEY', '');

    expect(() => decodoTools()).toThrow(/DECODO_API_KEY/);
  });

  it.each([
    ['a line break', 'secret\npart'],
    ['a carriage return', 'secret\rpart'],
    ['a non-Latin-1 character', 'secret\u0142part'],
  ])('refuses a key with %s without quoting it', (_, key) => {
    const refusal = (() => {
      try {
        decodoTools({ apiKey: key });
        return '';
      } catch (err) {
        return String(err);
      }
    })();

    expect(refusal).toMatch(/cannot be sent in a header/);
    expect(refusal).not.toMatch(/secret|part/);
  });

  it.each([
    ['scrape', { url: 'https://a.io' }, { results: [{ content: 'x', status_code: 200 }] }],
    ['search', { query: 'q' }, { status: 'done', organic: [] }],
    ['map', { url: 'https://a.io' }, { results: [{ content: { links: [] }, status_code: 200 }] }],
    ['crawl_start', { url: 'https://a.io' }, { crawl_id: 'c1', status: 'pending', url: 'x' }],
    ['crawl_status', { crawl_id: 'c1' }, { status: 'done' }],
    ['crawl_results', { crawl_id: 'c1' }, { crawl_id: 'c1', url: [] }],
    ['crawl_cancel', { crawl_id: 'c1' }, { crawl_id: 'c1', status: 'cancelled', url: 'x' }],
  ] as const)('%s sends the API key and x-integration', async (name, input, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await run(decodoTools({ apiKey: API_KEY })[name], input);

    const { url, headers } = lastRequest();
    expect(url.host).toBe('data.decodo.com');
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['x-integration']).toBe('ai-sdk');
  });
});

describe('input schemas', () => {
  const tools = decodoTools({ apiKey: API_KEY });

  it.each([
    ['scrape', { url: 'https://a.io', callback_url: 'https://evil.io' }],
    ['scrape', {}],
    ['search', { query: 'q', url: 'https://evil.io' }],
    ['map', { url: 'https://a.io', limit: 501 }],
    ['crawl_start', { url: 'https://a.io', callback_url: 'https://evil.io' }],
    ['crawl_start', { url: 'https://a.io', limit: 101 }],
    ['crawl_status', {}],
    ['crawl_results', {}],
    ['crawl_cancel', {}],
  ] as const)('%s refuses %j', (name, input) => {
    const schema = tools[name].inputSchema as z.ZodType;

    expect(schema.safeParse(input).success).toBe(false);
  });

  it('exposes JSON schemas a model can read', () => {
    const schema = z.toJSONSchema(tools.crawl_start.inputSchema as z.ZodType, {
      target: 'draft-7',
      io: 'input',
    });

    expect(schema.required).toEqual(['url']);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {})).not.toContain('callback_url');
  });
});

describe('scrape', () => {
  const tools = decodoTools({ apiKey: API_KEY });

  it('asks for universal markdown and returns it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ content: '# Hi', status_code: 200, url: 'https://a.io/' }] }),
    );

    const output = await run(tools.scrape, { url: 'https://a.io' });

    expect(lastRequest().url.pathname).toBe('/v1/scrape');
    expect(lastRequest().body).toEqual({
      url: 'https://a.io',
      target: 'universal',
      markdown: true,
    });
    expect(output).toEqual({ url: 'https://a.io/', content: '# Hi', truncated: false });
  });

  it('caps long pages and reports the full length', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ content: 'x'.repeat(50_000), status_code: 200 }] }),
    );

    const output = await run<object, { content: string; truncated: boolean; totalLength: number }>(
      tools.scrape,
      { url: 'https://a.io' },
    );

    expect(output.content).toHaveLength(45_000);
    expect(output.truncated).toBe(true);
    expect(output.totalLength).toBe(50_000);
  });

  it('does not split an emoji at the cap', async () => {
    const content = `${'x'.repeat(44_999)}😀${'y'.repeat(10)}`;
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ content, status_code: 200 }] }));

    const output = await run<object, { content: string }>(tools.scrape, { url: 'https://a.io' });

    expect(output.content).toBe('x'.repeat(44_999));
  });

  it.each([
    ['a faulted result', { results: [{ content: '', status_code: 613, help: 'Target blocked' }] }, /613: Target blocked/],
    ['empty results', { results: [] }, /no results/],
    ['missing results', {}, /no results/],
    ['a failed envelope', { status: 'failed', message: 'Nope' }, /Nope/],
  ])('treats %s in a 200 as a failure', async (_name, body, message) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(run(tools.scrape, { url: 'https://a.io' })).rejects.toThrow(message);
  });
});

describe('search and map', () => {
  const tools = decodoTools({ apiKey: API_KEY });

  it('search calls /v1/search', async () => {
    const body = { status: 'done', organic: [{ title: 't', link: 'l' }] };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(run(tools.search, { query: 'q' })).resolves.toEqual(body);
    expect(lastRequest().url.pathname).toBe('/v1/search');
  });

  it('search surfaces a failed envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'failed', message: 'Bad query' }));

    await expect(run(tools.search, { query: 'q' })).rejects.toThrow(/Bad query/);
  });

  it('map defaults the limit and returns plain URLs', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [{ content: { links: [{ url: 'https://a.io/1' }] }, status_code: 200 }],
      }),
    );

    await expect(run(tools.map, { url: 'https://a.io' })).resolves.toEqual({
      urls: ['https://a.io/1'],
    });
    expect(lastRequest().url.pathname).toBe('/v1/map');
    expect(lastRequest().body.limit).toBe(10);
  });
});

describe('crawl', () => {
  const tools = decodoTools({ apiKey: API_KEY });

  it('crawl_start returns at once with the id, bounded and in markdown', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ crawl_id: 'c1', status: 'pending', url: 'https://a.io', crawl_status: 'x' }),
    );

    await expect(run(tools.crawl_start, { url: 'https://a.io' })).resolves.toEqual({
      crawl_id: 'c1',
      status: 'pending',
      url: 'https://a.io',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequest().url.pathname).toBe('/v1/crawl');
    expect(lastRequest().body).toEqual({
      url: 'https://a.io',
      limit: 10,
      output: 'markdown',
    });
  });

  it('crawl_status reads the status route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'done', completed: 2 }));

    await expect(run(tools.crawl_status, { crawl_id: 'c1' })).resolves.toEqual({
      status: 'done',
      completed: 2,
    });
    expect(lastRequest().url.pathname).toBe('/v1/crawl/c1/status');
  });

  it('crawl_status waits before answering while the crawl is pending', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ status: 'pending' }));

    const onAnswer = vi.fn();
    const answer = run(tools.crawl_status, { crawl_id: 'c1' }).then(onAnswer);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(onAnswer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await answer;
    expect(onAnswer).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('crawl_results walks every page without losing any across the size cap', async () => {
    const upstream: Record<string, unknown> = {
      '': {
        crawl_id: 'c1',
        total: 3,
        url: [crawlPage('https://a.io/1', 'a'.repeat(30_000)), crawlPage('https://a.io/2', 'b'.repeat(30_000))],
        next: 'https://data.decodo.com/v1/crawl/c1?cursor=up2',
      },
      up2: { crawl_id: 'c1', url: [crawlPage('https://a.io/3', 'c')] },
    };
    fetchMock.mockImplementation(async (url) =>
      jsonResponse(upstream[new URL(url as string).searchParams.get('cursor') ?? '']),
    );

    type Output = { pages: { url: string }[]; nextCursor?: string; total?: number };
    const first = await run<object, Output>(tools.crawl_results, { crawl_id: 'c1' });
    const second = await run<object, Output>(tools.crawl_results, {
      crawl_id: 'c1',
      cursor: first.nextCursor,
    });
    const third = await run<object, Output>(tools.crawl_results, {
      crawl_id: 'c1',
      cursor: second.nextCursor,
    });

    expect(first.total).toBe(3);
    expect(first.pages.map(({ url }) => url)).toEqual(['https://a.io/1']);
    expect(second.pages.map(({ url }) => url)).toEqual(['https://a.io/2']);
    expect(third.pages.map(({ url }) => url)).toEqual(['https://a.io/3']);
    expect(third.nextCursor).toBeUndefined();
    expect(lastRequest().url.searchParams.get('type')).toBe('content');
  });

  it('crawl_results splits a page too long for one call and loses nothing', async () => {
    const long = `${'a'.repeat(44_000)}😀${'b'.repeat(60_000)}`;
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        crawl_id: 'c1',
        total: 2,
        url: [crawlPage('https://a.io/1', long), crawlPage('https://a.io/2', 'short')],
      }),
    );

    type Page = {
      url: string;
      content: string;
      contentPart?: { start: number; end: number; totalLength: number };
    };
    const seen: Page[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const output: { pages: Page[]; nextCursor?: string } = await run(tools.crawl_results, {
        crawl_id: 'c1',
        cursor,
      });
      seen.push(...output.pages);
      cursor = output.nextCursor;
      calls += 1;
    } while (cursor && calls < 10);

    const parts = seen.filter(({ url }) => url === 'https://a.io/1');
    expect(cursor).toBeUndefined();
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(({ content }) => content).join('')).toBe(long);
    expect(parts.every(({ content }) => content.length <= 45_000)).toBe(true);
    expect(parts.every(({ content }) => !/[\uD800-\uDBFF]$/.test(content))).toBe(true);
    expect(parts[1].contentPart?.start).toBe(parts[0].contentPart?.end);
    expect(parts.at(-1)?.contentPart?.end).toBe(long.length);
    expect(parts[0].contentPart?.totalLength).toBe(long.length);
    expect(seen.at(-1)).toMatchObject({ url: 'https://a.io/2', content: 'short' });
    expect(seen.at(-1)?.contentPart).toBeUndefined();
  });

  it('crawl_results stops once every page in total was returned', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        crawl_id: 'c1',
        total: 1,
        url: [crawlPage('https://a.io/1', 'a')],
        next: 'https://data.decodo.com/v1/crawl/c1?cursor=up2',
      }),
    );

    const { nextCursor } = await run<object, { nextCursor?: string }>(tools.crawl_results, {
      crawl_id: 'c1',
    });

    expect(nextCursor).toBeUndefined();
  });

  it('crawl_results refuses a cursor it did not issue', async () => {
    await expect(
      run(tools.crawl_results, { crawl_id: 'c1', cursor: 'nonsense' }),
    ).rejects.toThrow(/Invalid cursor/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('crawl_results treats an empty cursor as the start', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ crawl_id: 'c1', url: [crawlPage('https://a.io/1', 'a')] }),
    );

    const { pages } = await run<object, { pages: unknown[] }>(tools.crawl_results, {
      crawl_id: 'c1',
      cursor: '',
    });

    expect(pages).toHaveLength(1);
  });

  it('crawl_results moves forward when content_error fills the budget', async () => {
    const contentError = 'e'.repeat(60_000);
    const content = 'a'.repeat(2_500);
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        crawl_id: 'c1',
        url: [{ ...crawlPage('https://a.io/1', content), content_error: contentError }],
      }),
    );

    type Output = { pages: { content: string; content_error?: string }[]; nextCursor?: string };
    const parts: Output['pages'] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const output: Output = await run(tools.crawl_results, { crawl_id: 'c1', cursor });
      parts.push(...output.pages);
      cursor = output.nextCursor;
      calls += 1;
    } while (cursor && calls < 10);

    expect(cursor).toBeUndefined();
    expect(parts.map((part) => part.content).join('')).toBe(content);
    expect(parts[0].content_error).toBe(contentError);
  });

  it('crawl_cancel posts to the cancel route', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ crawl_id: 'c1', status: 'cancelled', url: 'https://a.io', crawl_status: 'x' }),
    );

    await expect(run(tools.crawl_cancel, { crawl_id: 'c1' })).resolves.toEqual({
      crawl_id: 'c1',
      status: 'cancelled',
      url: 'https://a.io',
    });
    expect(lastRequest().url.pathname).toBe('/v1/crawl/c1/cancel');
    expect(lastRequest().method).toBe('POST');
  });
});

describe('errors', () => {
  const tools = decodoTools({ apiKey: API_KEY });

  it.each([
    [401, { message: 'Invalid key' }, /Invalid key.*DECODO_API_KEY/],
    [429, { message: 'Too many' }, /Too many.*Retry later/],
    [422, { message: 'Bad url' }, /Bad url.*Change the input/],
    [400, { message: 'Invalid URL format.' }, /refused the input: Invalid URL format\. Change the input/],
    [500, { message: 'Boom' }, /500: Boom.*Retry later/],
  ])('maps status %i to a readable message', async (status, body, message) => {
    fetchMock.mockResolvedValue(jsonResponse(body, status));

    await expect(run(tools.search, { query: 'q' })).rejects.toThrow(message);
  });

  it('does not blame the input when the target page answers 400', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ status_code: 400, help: 'Bad target' }] }));

    await expect(run(tools.scrape, { url: 'https://a.io' })).rejects.toThrow(
      /failed with status 400: Bad target\.$/,
    );
  });

  it('maps a request timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(run(tools.search, { query: 'q' })).rejects.toThrow(/did not answer in time/);
  });

  it('does not double the period of an SDK message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Invalid key.' }, 401));

    await expect(run(tools.search, { query: 'q' })).rejects.toThrow(/Invalid key\. Check/);
  });

  it('keeps the original error as the cause', async () => {
    const failure = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(failure);

    await expect(run(tools.search, { query: 'q' })).rejects.toMatchObject({
      message: expect.stringContaining('fetch failed'),
      cause: failure,
    });
  });
});

describe('with generateText', () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };

  const modelCalling = (toolName: string, input: unknown) => {
    let step = 0;
    const seenTools: { name: string; inputSchema: { properties: object } }[][] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async ({ tools }) => {
        seenTools.push(tools as (typeof seenTools)[number]);
        step += 1;
        return step === 1
          ? {
              content: [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'call-1',
                  toolName,
                  input: JSON.stringify(input),
                },
              ],
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
              usage,
              warnings: [],
            }
          : {
              content: [{ type: 'text' as const, text: 'done' }],
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage,
              warnings: [],
            };
      },
    });
    return { model, seenTools };
  };

  it('runs a tool call end to end', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ content: '# Hi', status_code: 200 }] }),
    );
    const { model, seenTools } = modelCalling('scrape', { url: 'https://a.io' });

    const result = await generateText({
      model,
      tools: decodoTools({ apiKey: API_KEY }),
      stopWhen: stepCountIs(3),
      prompt: 'Read it',
    });

    expect(result.text).toBe('done');
    expect(result.steps[0].toolResults[0].output).toMatchObject({ content: '# Hi' });
    const crawlStart = seenTools[0].find(({ name }) => name === 'crawl_start');
    expect(Object.keys(crawlStart?.inputSchema.properties ?? {})).toContain('max_depth');
    expect(Object.keys(crawlStart?.inputSchema.properties ?? {})).not.toContain('callback_url');
  });

  it('hands a rejected key back to the model instead of crashing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Invalid key' }, 401));
    const { model } = modelCalling('search', { query: 'q' });

    const result = await generateText({
      model,
      tools: decodoTools({ apiKey: 'bad' }),
      stopWhen: stepCountIs(3),
      prompt: 'Find it',
    });

    expect(result.text).toBe('done');
    const toolError = result.steps[0].content.find(({ type }) => type === 'tool-error');
    expect(String((toolError as { error: unknown }).error)).toMatch(/DECODO_API_KEY/);
  });

  it('refuses a callback_url the model made up before any request', async () => {
    const { model } = modelCalling('crawl_start', {
      url: 'https://a.io',
      callback_url: 'https://evil.io',
    });

    const result = await generateText({
      model,
      tools: decodoTools({ apiKey: API_KEY }),
      stopWhen: stepCountIs(3),
      prompt: 'Crawl it',
    });

    expect(result.text).toBe('done');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
