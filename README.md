# Decodo tools for the Vercel AI SDK

[Vercel AI SDK](https://ai-sdk.dev) tools for the Decodo Web Data API: scrape, search and map
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

## Errors

A failed call reaches the model as a tool error it can read and act on, and `generateText` keeps
running:

- A rejected API key names `DECODO_API_KEY`.
- Rate limits, timeouts and 5xx answers say to retry later.
- Validation errors say to change the input.
- A page that could not be scraped is an error, even when the API answered 200.

`decodoTools()` throws right away when there is no API key at all.

## License

Released under the [MIT License](https://github.com/Decodo/Decodo/blob/master/LICENSE).
