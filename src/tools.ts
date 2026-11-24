import {
  dataApiRequestSchemas,
  DecodoClient,
  requestSchemas,
  Target,
} from '@decodo/sdk-ts';
import type {
  CancelCrawlResponse,
  GetCrawlStatusResponse,
  MapSiteRequest,
  RunSearchRequest,
  RunSearchResponse,
  StartCrawlRequest,
  StartCrawlResponse,
  TargetParamsMap,
} from '@decodo/sdk-ts';
import { tool } from 'ai';
import type { Tool } from 'ai';
import * as z from 'zod';
import { capContent, readCrawlPages } from './content.js';
import type { CappedContent, CrawlPagesOutput } from './content.js';
import { TargetError, withReadableErrors } from './errors.js';

const INTEGRATION_HEADER = 'ai-sdk';
const DEFAULT_LIMIT = 10;
const MAX_CRAWL_LIMIT = 100;
const MAX_MAP_LIMIT = 500;
const PENDING_CRAWL_WAIT_MS = 5_000;

export type DecodoToolsConfig = {
  apiKey?: string;
};

type ScrapeInput = Required<Pick<TargetParamsMap[Target.Universal], 'url'>> &
  Pick<TargetParamsMap[Target.Universal], 'geo' | 'locale'> & { headless?: 'html' };
type SearchInput = Pick<RunSearchRequest, 'query' | 'geo' | 'locale' | 'page'>;
type SiteInputField =
  | 'url'
  | 'limit'
  | 'sitemap'
  | 'domain_filter'
  | 'select_paths'
  | 'exclude_paths'
  | 'geo'
  | 'locale';
type MapInput = Pick<MapSiteRequest, SiteInputField>;
type CrawlStartInput = Pick<StartCrawlRequest, SiteInputField | 'max_depth'>;
type CrawlIdInput = { crawl_id: string };
type CrawlResultsInput = { crawl_id: string; cursor?: string };

export type DecodoTools = {
  scrape: Tool<ScrapeInput, { url: string } & CappedContent>;
  search: Tool<SearchInput, Exclude<RunSearchResponse, { status: 'failed' }>>;
  map: Tool<MapInput, { urls: string[] }>;
  crawl_start: Tool<CrawlStartInput, Pick<StartCrawlResponse, 'crawl_id' | 'status' | 'url'>>;
  crawl_status: Tool<CrawlIdInput, GetCrawlStatusResponse>;
  crawl_results: Tool<CrawlResultsInput, CrawlPagesOutput>;
  crawl_cancel: Tool<CrawlIdInput, Pick<CancelCrawlResponse, 'crawl_id' | 'status' | 'url'>>;
};

const siteFields = {
  url: true,
  sitemap: true,
  domain_filter: true,
  select_paths: true,
  exclude_paths: true,
  geo: true,
  locale: true,
} as const;

const limitField = (items: string, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Maximum ${items}. Defaults to ${DEFAULT_LIMIT}, at most ${max}.`);

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

const searchInput = dataApiRequestSchemas.runSearch
  .pick({ query: true, geo: true, locale: true })
  .extend({
    page: z.number().int().min(1).optional().describe('Results page to return, 1 by default.'),
  })
  .strict() as unknown as z.ZodType<SearchInput>;

const mapInput = dataApiRequestSchemas.mapSite
  .pick(siteFields)
  .extend({ limit: limitField('URLs to return', MAX_MAP_LIMIT) })
  .strict() as unknown as z.ZodType<MapInput>;

const crawlStartInput = dataApiRequestSchemas.startCrawl
  .pick({ ...siteFields, max_depth: true })
  .extend({ limit: limitField('pages to crawl', MAX_CRAWL_LIMIT) })
  .strict() as unknown as z.ZodType<CrawlStartInput>;

const crawlIdField = z.string().min(1).describe('Crawl id returned by crawl_start.');

const successfulResults = <Result extends { status_code: number; help?: string }>(
  response: { results?: Result[]; status?: string; message?: string },
) => {
  if (response.status === 'failed') {
    throw new TargetError(response.message ?? 'The request failed', 502, 'failed');
  }
  if (!Array.isArray(response.results) || response.results.length === 0) {
    throw new TargetError('The response has no results', 502, 'failed');
  }

  const successful = response.results.filter((result) => result.status_code < 400);
  if (successful.length === 0) {
    const [{ status_code: statusCode, help }] = response.results;
    throw new TargetError(help ?? 'The target page could not be fetched', statusCode, 'failed');
  }
  return successful;
};

const HEADER_SAFE = /^[\x21-\x7e]+$/;

const resolveApiKey = (apiKey = process.env.DECODO_API_KEY): string => {
  if (!apiKey?.trim()) {
    throw new Error(
      'Decodo API key is missing. Pass apiKey to decodoTools() or set DECODO_API_KEY. Keys are at https://dashboard.decodo.com/web-data/playground.',
    );
  }
  const key = apiKey.trim();
  if (!HEADER_SAFE.test(key)) {
    throw new Error(
      'Decodo API key has a line break, space or other character that cannot be sent in a header. Copy it again from https://dashboard.decodo.com/web-data/playground.',
    );
  }
  return key;
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

    search: tool({
      description:
        'Search the web through the Decodo Web Data API and return ranked results with title, link and description. ' +
        'To read a result, pass its link to scrape.',
      inputSchema: searchInput,
      execute: withReadableErrors(async (input: SearchInput) => {
        const response = await api.search(input);
        if (response.status === 'failed') {
          throw new TargetError(response.message, response.status_code ?? 502, 'failed');
        }
        return response;
      }),
    }),

    map: tool({
      description:
        'List the URLs of a website without fetching their content. ' +
        'Narrow large sites with select_paths or exclude_paths, then scrape only the pages you need.',
      inputSchema: mapInput,
      execute: withReadableErrors(async ({ limit, ...input }: MapInput) => {
        const results = successfulResults(
          await api.map({ ...input, limit: limit ?? DEFAULT_LIMIT }),
        );
        return { urls: results.flatMap(({ content }) => content.links.map(({ url }) => url)) };
      }),
    }),

    crawl_start: tool({
      description:
        'Start crawling a website and return its crawl_id right away, without waiting for it to finish. ' +
        'Check progress with crawl_status, then read pages with crawl_results. Stop it early with crawl_cancel. ' +
        'For precise work, prefer map plus scrape on the pages you need.',
      inputSchema: crawlStartInput,
      execute: withReadableErrors(async ({ limit, ...input }: CrawlStartInput) => {
        const { crawl_id, status, url } = await api.startCrawl({
          ...input,
          limit: limit ?? DEFAULT_LIMIT,
          output: 'markdown',
        });
        return { crawl_id, status, url };
      }),
    }),

    crawl_status: tool({
      description:
        'Report the progress of a crawl started with crawl_start: its status and how many pages were discovered, completed and failed. ' +
        'The crawl is finished once status is no longer "pending". ' +
        'While it is pending this tool waits a few seconds before answering, so call it again right away.',
      inputSchema: z.object({ crawl_id: crawlIdField }).strict(),
      execute: withReadableErrors(async ({ crawl_id }: CrawlIdInput) => {
        const status = await api.getCrawlStatus(crawl_id);
        if (status.status === 'pending') {
          await new Promise((resolve) => setTimeout(resolve, PENDING_CRAWL_WAIT_MS));
        }
        return status;
      }),
    }),

    crawl_results: tool({
      description:
        'Return crawled pages as Markdown from a crawl started with crawl_start, about 45,000 characters per call. ' +
        'Call it once crawl_status reports the crawl is no longer "pending". ' +
        'Pass nextCursor back to get more; when it is missing, you have every page. ' +
        'A page too long for one call is split across calls; each part carries contentPart with its character range.',
      inputSchema: z
        .object({
          crawl_id: crawlIdField,
          cursor: z
            .string()
            .optional()
            .describe('nextCursor from a previous crawl_results call; omit for the first pages.'),
        })
        .strict(),
      execute: withReadableErrors(({ crawl_id, cursor }: CrawlResultsInput) =>
        readCrawlPages(cursor, (upstreamCursor) =>
          api.listCrawlPages(crawl_id, { cursor: upstreamCursor }),
        ),
      ),
    }),

    crawl_cancel: tool({
      description:
        'Stop a crawl started with crawl_start so it crawls no more pages. ' +
        'Pages crawled before the cancel stay readable with crawl_results.',
      inputSchema: z.object({ crawl_id: crawlIdField }).strict(),
      execute: withReadableErrors(async ({ crawl_id }: CrawlIdInput) => {
        const { crawl_id: id, status, url } = await api.cancelCrawl(crawl_id);
        return { crawl_id: id, status, url };
      }),
    }),
  };
};
