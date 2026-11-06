import { anthropic } from '@ai-sdk/anthropic';
import { decodoTools } from '@decodo/ai-sdk';
import { generateText, stepCountIs } from 'ai';

const { crawl_start, crawl_status, crawl_results } = decodoTools();
const { text } = await generateText({
  model: anthropic('claude-sonnet-5-5'),
  tools: { crawl_start, crawl_status, crawl_results },
  stopWhen: stepCountIs(30),
  prompt: 'Crawl 5 pages of https://decodo.com and summarise what the company sells.',
});

console.log(text);
