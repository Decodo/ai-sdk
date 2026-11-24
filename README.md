# Decodo tools for the Vercel AI SDK

[Vercel AI SDK](https://ai-sdk.dev) tools for the Decodo Web Data API: scrape, search, map and crawl
the web from any model.

## Install

```bash
npm install @decodo/ai-sdk ai @ai-sdk/anthropic
```

`ai` v6 or v7 is a peer dependency. The examples use `@ai-sdk/anthropic` and read
`ANTHROPIC_API_KEY`; any AI SDK model provider works.

## API key

Get a Web Data API key from the [Decodo dashboard](https://dashboard.decodo.com/web-data/playground)
and set it as `DECODO_API_KEY`, or pass it as `decodoTools({ apiKey })`.

## Usage

```typescript
import { anthropic } from '@ai-sdk/anthropic';
import { decodoTools } from '@decodo/ai-sdk';
import { generateText, stepCountIs } from 'ai';

const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: decodoTools({ apiKey: process.env.DECODO_API_KEY }),
  stopWhen: stepCountIs(5),
  prompt: 'Scrape https://ip.decodo.com and tell me the country of the IP in one sentence.',
});

console.log(text);
```

## Tools

| Tool | What the model gets |
|---|---|
| `scrape` | One page as Markdown, cut at 45,000 characters with `truncated` and `totalLength` |
| `search` | Ranked search results |
| `map` | A site's URLs, 10 by default and at most 500 |
| `crawl_start` | A `crawl_id` right away; crawls 10 pages by default and at most 100 |
| `crawl_status` | Status and page counts; finished once `status` is no longer `pending` |
| `crawl_results` | Crawled pages as Markdown, about 45,000 characters per call, with `nextCursor` for the rest |
| `crawl_cancel` | Stops a crawl; pages crawled so far stay readable |

A crawled page too long for one call is split across calls, and each part carries `contentPart`
with its character range. Every page also comes back with its `url`, `depth`, `status` and
`content_error`, and the response carries `total`, so a model can tell how much is left to read.

A model polls `crawl_status` by calling it again, and each call uses a step, so give crawling
prompts a higher `stepCountIs`. While a crawl is pending, `crawl_status` waits 5 seconds before
answering, which slows polling and keeps a long crawl from using up the steps.

### Inputs

Inputs are strict: a field that isn't listed is refused rather than ignored.

| Tool | Inputs |
|---|---|
| `scrape` | `url` (required), `geo`, `locale`, and `headless: 'html'` to render JavaScript first |
| `search` | `query` (required), `geo`, `locale`, `page` |
| `map` | `url` (required), `limit`, `sitemap`, `domain_filter`, `select_paths`, `exclude_paths`, `geo`, `locale` |
| `crawl_start` | the `map` inputs, plus `max_depth` |
| `crawl_status`, `crawl_cancel` | `crawl_id` |
| `crawl_results` | `crawl_id`, `cursor` |

`limit`, `max_depth`, `select_paths` and `exclude_paths` are what keep a crawl off the parts of a
site you don't need, so they are worth setting in the prompt.

### Scrape

```typescript
const { scrape } = decodoTools();
const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: { scrape },
  stopWhen: stepCountIs(5),
  prompt: 'Scrape https://ip.decodo.com and tell me the country of the IP.',
});
```

### Search

```typescript
const { search } = decodoTools();
const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: { search },
  stopWhen: stepCountIs(5),
  prompt: 'Search the web for what a web data API is and answer in one sentence.',
});
```

### Map

```typescript
const { map } = decodoTools();
const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: { map },
  stopWhen: stepCountIs(5),
  prompt: 'List 20 URLs from https://decodo.com.',
});
```

### Crawl

```typescript
const { crawl_start, crawl_status, crawl_results } = decodoTools();
const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: { crawl_start, crawl_status, crawl_results },
  stopWhen: stepCountIs(30),
  prompt: 'Crawl 5 pages of https://decodo.com and summarise what the company sells.',
});
```

## Examples

`examples/` holds runnable versions of the snippets above. Build once, then run them on the Node
version in `.nvmrc`, which reads TypeScript directly:

```bash
pnpm install
pnpm run build:esm
DECODO_API_KEY=... ANTHROPIC_API_KEY=... node examples/generate-text.ts
DECODO_API_KEY=... ANTHROPIC_API_KEY=... node examples/crawl.ts
```

## Errors

A failed call reaches the model as a tool error it can read and act on, and `generateText` keeps
running:

- A rejected API key names `DECODO_API_KEY`.
- Rate limits, timeouts and 5xx answers say to retry later.
- Validation errors say to change the input.
- A page that could not be scraped is an error, even when the API answered 200.

`decodoTools()` throws right away when the API key is missing, and when it carries a line break,
space or other character that cannot be sent in a header.

## License

Released under the [MIT License](https://github.com/Decodo/Decodo/blob/master/LICENSE).
