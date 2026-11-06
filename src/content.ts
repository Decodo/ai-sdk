const MAX_CONTENT_CHARS = 45_000;

export type CappedContent = {
  content: string;
  truncated: boolean;
  totalLength?: number;
};

const sliceWithinChars = (content: string, maxChars: number) => {
  const endsInsidePair = /[\uD800-\uDBFF]/.test(content.charAt(maxChars - 1));
  return content.slice(0, endsInsidePair ? maxChars - 1 : maxChars);
};

export const capContent = (content: string): CappedContent =>
  content.length > MAX_CONTENT_CHARS
    ? {
        content: sliceWithinChars(content, MAX_CONTENT_CHARS),
        truncated: true,
        totalLength: content.length,
      }
    : { content, truncated: false };
