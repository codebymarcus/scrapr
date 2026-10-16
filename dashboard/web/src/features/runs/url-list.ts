const HTTP_URL = /^https?:\/\//i;

export type InvalidUrlLine = {
  /** 1-based line number in the pasted text. */
  line: number;
  text: string;
};

export type ParsedUrlList = {
  urls: string[];
  invalid: InvalidUrlLine[];
};

/** Splits pasted text into trimmed, non-blank lines and checks each is http(s). */
export function parseUrlList(text: string): ParsedUrlList {
  const urls: string[] = [];
  const invalid: InvalidUrlLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") {
      return;
    }
    if (HTTP_URL.test(line)) {
      urls.push(line);
    } else {
      invalid.push({ line: index + 1, text: line });
    }
  });
  return { urls, invalid };
}

export function describeInvalidLines(invalid: InvalidUrlLine[]): string {
  const [first, ...rest] = invalid;
  const base = `Line ${first.line} must start with http:// or https://`;
  if (rest.length === 0) {
    return `${base}.`;
  }
  return `${base} (and ${rest.length} more ${rest.length === 1 ? "line is" : "lines are"} invalid).`;
}
