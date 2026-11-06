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

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('decodoTools', () => {
  it('returns the scrape tool', () => {
    expect(Object.keys(decodoTools({ apiKey: API_KEY })).sort()).toEqual([
      'scrape',
    ]);
  });

  it('falls back to DECODO_API_KEY', async () => {
    vi.stubEnv('DECODO_API_KEY', 'env-key');
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ content: 'x', status_code: 200 }] }));

    await run(decodoTools().scrape, { url: 'https://a.io' });

    expect(lastRequest().headers.Authorization).toBe('Bearer env-key');
  });

  it('names DECODO_API_KEY when no key is available', () => {
    vi.stubEnv('DECODO_API_KEY', '');

    expect(() => decodoTools()).toThrow(/DECODO_API_KEY/);
  });

  it.each([
    ['scrape', { url: 'https://a.io' }, { results: [{ content: 'x', status_code: 200 }] }],
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
  ] as const)('%s refuses %j', (name, input) => {
    const schema = tools[name].inputSchema as z.ZodType;

    expect(schema.safeParse(input).success).toBe(false);
  });

  it('exposes JSON schemas a model can read', () => {
    const schema = z.toJSONSchema(tools.scrape.inputSchema as z.ZodType, {
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

describe('errors', () => {
  const tools = decodoTools({ apiKey: API_KEY });

  it.each([
    [401, { message: 'Invalid key' }, /Invalid key.*DECODO_API_KEY/],
    [429, { message: 'Too many' }, /Too many.*Retry later/],
    [422, { message: 'Bad url' }, /Bad url.*Change the input/],
    [500, { message: 'Boom' }, /500: Boom.*Retry later/],
  ])('maps status %i to a readable message', async (status, body, message) => {
    fetchMock.mockResolvedValue(jsonResponse(body, status));

    await expect(run(tools.scrape, { url: 'https://a.io' })).rejects.toThrow(message);
  });

  it('maps a request timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(run(tools.scrape, { url: 'https://a.io' })).rejects.toThrow(/did not answer in time/);
  });

  it('does not double the period of an SDK message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Invalid key.' }, 401));

    await expect(run(tools.scrape, { url: 'https://a.io' })).rejects.toThrow(/Invalid key\. Check/);
  });

  it('keeps the original error as the cause', async () => {
    const failure = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(failure);

    await expect(run(tools.scrape, { url: 'https://a.io' })).rejects.toMatchObject({
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
    const scrape = seenTools[0].find(({ name }) => name === 'scrape');
    expect(Object.keys(scrape?.inputSchema.properties ?? {})).toContain('geo');
    expect(Object.keys(scrape?.inputSchema.properties ?? {})).not.toContain('callback_url');
  });

  it('hands a rejected key back to the model instead of crashing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Invalid key' }, 401));
    const { model } = modelCalling('scrape', { url: 'https://a.io' });

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
    const { model } = modelCalling('scrape', {
      url: 'https://a.io',
      callback_url: 'https://evil.io',
    });

    const result = await generateText({
      model,
      tools: decodoTools({ apiKey: API_KEY }),
      stopWhen: stepCountIs(3),
      prompt: 'Read it',
    });

    expect(result.text).toBe('done');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
