import {
  AuthenticationError,
  DecodoError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '@decodo/sdk-ts';

const asSentence = (message: string) => message.replace(/\.+$/, '');

const describeError = (err: unknown): string => {
  if (err instanceof AuthenticationError) {
    return `Decodo rejected the API key: ${asSentence(err.message)}. Check DECODO_API_KEY; keys are at https://dashboard.decodo.com/web-data/playground.`;
  }
  if (err instanceof RateLimitError) {
    return `Decodo rate limit or request quota reached: ${asSentence(err.message)}. Retry later.`;
  }
  if (err instanceof ValidationError) {
    return `Decodo refused the input: ${asSentence(err.message)}. Change the input before calling again.`;
  }
  if (err instanceof TimeoutError) {
    return `Decodo did not answer in time: ${asSentence(err.message)}. Retry later.`;
  }
  if (err instanceof DecodoError) {
    const retry = err.statusCode >= 500 ? ' Retry later.' : '';
    return `Decodo request failed with status ${err.statusCode}: ${asSentence(err.message)}.${retry}`;
  }
  return `Decodo request failed: ${asSentence(err instanceof Error ? err.message : String(err))}. Retry later.`;
};

export const withReadableErrors =
  <Input, Output>(execute: (input: Input) => Promise<Output>) =>
  async (input: Input): Promise<Output> => {
    try {
      return await execute(input);
    } catch (err) {
      throw new Error(describeError(err), { cause: err });
    }
  };
