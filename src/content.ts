import type { CrawlPage, CrawlPageList } from '@decodo/sdk-ts';
import { ValidationError } from '@decodo/sdk-ts';

const MAX_CONTENT_CHARS = 45_000;
const PAGE_FIELDS_CHARS = 100;
const MIN_PART_CHARS = 1_000;

export type CappedContent = {
  content: string;
  truncated: boolean;
  totalLength?: number;
};

type ContentPart = {
  start: number;
  end: number;
  totalLength: number;
};

export type CrawlPagesOutput = {
  pages: (Pick<CrawlPage, 'url' | 'depth' | 'status' | 'content_error'> & {
    content: string;
    contentPart?: ContentPart;
  })[];
  nextCursor?: string;
  total?: number;
};

type ResultsPosition = {
  offset: number;
  contentOffset: number;
  returned: number;
  upstreamCursor?: string;
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

const invalidCursor = () =>
  new ValidationError(
    'Invalid cursor: pass the nextCursor value from a previous crawl_results call',
  );

const parseCursor = (cursor?: string): ResultsPosition => {
  if (!cursor) {
    return { offset: 0, contentOffset: 0, returned: 0 };
  }
  const parsed = /^(\d+):(\d+):(\d+):(.*)$/s.exec(cursor);
  if (!parsed) {
    throw invalidCursor();
  }
  const [offset, contentOffset, returned] = parsed.slice(1, 4).map(Number);
  if (![offset, contentOffset, returned].every(Number.isSafeInteger)) {
    throw invalidCursor();
  }
  return { offset, contentOffset, returned, upstreamCursor: parsed[4] || undefined };
};

const formatCursor = ({ offset, contentOffset, returned, upstreamCursor = '' }: ResultsPosition) =>
  `${offset}:${contentOffset}:${returned}:${upstreamCursor}`;

const pageCost = (page: CrawlPage) =>
  PAGE_FIELDS_CHARS + page.url.length + (page.content_error?.length ?? 0);

const takePages = (pages: CrawlPage[], start: ResultsPosition) => {
  const taken: CrawlPagesOutput['pages'] = [];
  let remaining = MAX_CONTENT_CHARS;
  let { offset, contentOffset, returned } = start;

  while (offset < pages.length) {
    const page = pages[offset];
    const cost = pageCost(page);
    const content = page.content ?? '';
    const unread = content.slice(contentOffset);
    const fits = cost + unread.length <= remaining;

    if (!fits && taken.length > 0) {
      break;
    }

    const part = fits ? unread : sliceWithinChars(unread, Math.max(MIN_PART_CHARS, remaining - cost));
    const isWhole = part.length === unread.length;
    const isSplit = contentOffset > 0 || !isWhole;

    taken.push({
      url: page.url,
      depth: page.depth,
      status: page.status,
      content_error: page.content_error,
      content: part,
      ...(isSplit && {
        contentPart: {
          start: contentOffset,
          end: contentOffset + part.length,
          totalLength: content.length,
        },
      }),
    });

    if (!isWhole) {
      contentOffset += part.length;
      break;
    }

    remaining -= cost + part.length;
    offset += 1;
    contentOffset = 0;
    returned += 1;
  }

  return { taken, stoppedAt: { ...start, offset, contentOffset, returned } };
};

const nextPosition = (list: CrawlPageList, stoppedAt: ResultsPosition) => {
  if (stoppedAt.offset < list.pages.length) {
    return stoppedAt;
  }
  const hasEveryPage = list.total !== undefined && stoppedAt.returned >= list.total;
  if (hasEveryPage || !list.next) {
    return undefined;
  }
  return { offset: 0, contentOffset: 0, returned: stoppedAt.returned, upstreamCursor: list.next };
};

export const readCrawlPages = async (
  cursor: string | undefined,
  listPages: (upstreamCursor?: string) => Promise<CrawlPageList>,
): Promise<CrawlPagesOutput> => {
  const position = parseCursor(cursor);
  const list = await listPages(position.upstreamCursor);
  const { taken, stoppedAt } = takePages(list.pages, position);
  const next = nextPosition(list, stoppedAt);

  return { pages: taken, nextCursor: next && formatCursor(next), total: list.total };
};
