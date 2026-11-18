// Structural PDF checks that need no AI. Reads raw bytes plus every Flate stream,
// because modern PDFs hide the catalog (where /StructTreeRoot and /Lang live) in compressed object streams.

export interface PdfFacts {
  tagged: boolean; // has a structure tree, so screen readers get headings, lists, reading order
  title: boolean;
  lang: boolean;
  hasText: boolean; // false = image only, e.g. a scan with no OCR
}

export function factsFromText(s: string): PdfFacts {
  return {
    tagged: /\/StructTreeRoot\s/.test(s),
    title: goodTitle(s),
    lang: /\/Lang\s*[(<]/.test(s),
    hasText: /\/Type\s*\/Font\b/.test(s) || /\/Font\s*<</.test(s),
  };
}

/** A title must exist and describe the document. "lunch-form" or "Microsoft Word - doc1.docx" does not. */
function goodTitle(s: string): boolean {
  const t = (s.match(/\/Title\s*\(([^)]*)\)/)?.[1] ?? s.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]*)</)?.[1] ?? '').trim();
  if (!t) return /\/Title\s*<[0-9a-fA-F]{4,}>/.test(s); // hex-encoded titles: accept if present
  return !/^[\w.-]+$/.test(t) && !/\.(docx?|pdf|pptx?|xlsx?)$/i.test(t) && !/^untitled/i.test(t);
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return latin1(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function pdfFacts(buf: ArrayBuffer): Promise<PdfFacts> {
  const bytes = new Uint8Array(buf);
  const raw = latin1(bytes);
  const parts = [raw];
  // ponytail: linear scan of streams, capped at 300; enough for school PDFs, a real parser if needed later.
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(raw)) && count < 300) {
    const dictStart = raw.lastIndexOf('obj', m.index);
    if (dictStart < 0 || !raw.slice(dictStart, m.index).includes('/FlateDecode')) continue;
    const end = raw.indexOf('endstream', m.index);
    if (end < 0) break;
    count++;
    try {
      parts.push(await inflate(bytes.subarray(m.index + m[0].length, end)));
    } catch {
      // damaged or image stream; skip
    }
  }
  return factsFromText(parts.join('\n'));
}

const VAGUE_LINK = /^(click here|here|click|download|link|more|read more|learn more|pdf|this|view|open|form)$/i;

export function vagueLinkText(text: string): boolean {
  const t = text.trim().replace(/[.:]$/, '');
  return t === '' || VAGUE_LINK.test(t) || /\.pdf$/i.test(t);
}
