import {
  AuthenticationError,
  DecodoError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from '@decodo/sdk-ts';

export class TargetError extends DecodoError {}

const RETRY_LATER = 'Retry later.';
export const DO_NOT_RESEND =
  'The request may still have run, so do not send it again unless asked.';

const asSentence = (message: string) => message.replace(/\.+$/, '');

const refusedInput = (err: unknown): err is DecodoError =>
  err instanceof ValidationError ||
  (err instanceof DecodoError && err.statusCode === 400 && !(err instanceof TargetError));

const describeError = (err: unknown, afterTimeout: string): string => {
  if (err instanceof AuthenticationError) {
    return `Decodo rejected the API key: ${asSentence(err.message)}. Check DECODO_API_KEY; keys are at https://dashboard.decodo.com/web-data/playground.`;
  }
  if (err instanceof RateLimitError) {
    return `Decodo rate limit or request quota reached: ${asSentence(err.message)}. Retry later.`;
  }
  if (refusedInput(err)) {
    return `Decodo refused the input: ${asSentence(err.message)}. Change the input before calling again.`;
  }
  if (err instanceof TimeoutError) {
    return `Decodo did not answer in time: ${asSentence(err.message)}. ${afterTimeout}`;
  }
  if (err instanceof DecodoError) {
    const retry = err.statusCode >= 500 ? ' Retry later.' : '';
    return `Decodo request failed with status ${err.statusCode}: ${asSentence(err.message)}.${retry}`;
  }
  return `Decodo request failed: ${asSentence(err instanceof Error ? err.message : String(err))}. Retry later.`;
};

export const withReadableErrors =
  <Input, Output>(execute: (input: Input) => Promise<Output>, afterTimeout = RETRY_LATER) =>
  async (input: Input): Promise<Output> => {
    try {
      return await execute(input);
    } catch (err) {
      throw new Error(describeError(err, afterTimeout), { cause: err });
    }
  };
