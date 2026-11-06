import {
  DecodoClient,
  DecodoError,
  requestSchemas,
  Target,
} from '@decodo/sdk-ts';
import type { TargetParamsMap } from '@decodo/sdk-ts';
import { tool } from 'ai';
import type { Tool } from 'ai';
import * as z from 'zod';
import { capContent } from './content.js';
import type { CappedContent } from './content.js';
import { withReadableErrors } from './errors.js';

const INTEGRATION_HEADER = 'ai-sdk';

export type DecodoToolsConfig = {
  apiKey?: string;
};

type ScrapeInput = Required<Pick<TargetParamsMap[Target.Universal], 'url'>> &
  Pick<TargetParamsMap[Target.Universal], 'geo' | 'locale'> & { headless?: 'html' };

export type DecodoTools = {
  scrape: Tool<ScrapeInput, { url: string } & CappedContent>;
};

const scrapeInput = requestSchemas[Target.Universal]
  .required({ url: true })
  .pick({ url: true, geo: true, locale: true })
  .extend({
    headless: z
      .literal('html')
      .optional()
      .describe('Set to "html" to render JavaScript before reading the page.'),
  })
  .strict() as unknown as z.ZodType<ScrapeInput>;

const successfulResults = <Result extends { status_code: number; help?: string }>(
  response: { results?: Result[]; status?: string; message?: string },
) => {
  if (response.status === 'failed') {
    throw new DecodoError(response.message ?? 'The request failed', 502, 'failed');
  }
  if (!Array.isArray(response.results) || response.results.length === 0) {
    throw new DecodoError('The response has no results', 502, 'failed');
  }

  const successful = response.results.filter((result) => result.status_code < 400);
  if (successful.length === 0) {
    const [{ status_code: statusCode, help }] = response.results;
    throw new DecodoError(help ?? 'The target page could not be fetched', statusCode, 'failed');
  }
  return successful;
};

const resolveApiKey = (apiKey = process.env.DECODO_API_KEY): string => {
  if (!apiKey?.trim()) {
    throw new Error(
      'Decodo API key is missing. Pass apiKey to decodoTools() or set DECODO_API_KEY. Keys are at https://dashboard.decodo.com/web-data/playground.',
    );
  }
  return apiKey.trim();
};

export const decodoTools = ({ apiKey }: DecodoToolsConfig = {}): DecodoTools => {
  const { webScrapingApi: api } = new DecodoClient({
    webScrapingApi: { apiKey: resolveApiKey(apiKey), integrationHeader: INTEGRATION_HEADER },
  });

  return {
    scrape: tool({
      description:
        'Fetch one public web page through the Decodo Web Data API and return it as Markdown. ' +
        'Long pages are cut off; truncated and totalLength say when that happened.',
      inputSchema: scrapeInput,
      execute: withReadableErrors(async (input: ScrapeInput) => {
        const [result] = successfulResults(
          await api.scrape({ ...input, target: Target.Universal, markdown: true }),
        );
        const content =
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
        return { url: result.url ?? input.url, ...capContent(content) };
      }),
    }),
  };
};
