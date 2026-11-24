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
