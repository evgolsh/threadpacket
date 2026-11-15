/**
 * Any file type is accepted. Binary preview types (PDF, PNG, JPEG) are recognised strictly from magic bytes so a
 * declared label can never make a browser or assistant render other bytes inline. UTF-8 text and structured text
 * formats keep their specific MIME types (Markdown, CSV, JSON, YAML, HTML, SVG, XML, plain text), while non-UTF-8
 * binaries keep their well-formed declared or filename-inferred MIME type and are always downloaded as attachments.
 */
export const READABLE_BINARY_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

/** Types that may only be stored when the content is valid UTF-8 text (never arbitrary binary bytes). */
const UTF8_ONLY_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/sql",
  "application/javascript",
  "application/typescript",
]);

/** HTTP form transport types sent by default clients (such as curl --data-binary); never real file MIME types. */
const TRANSPORT_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data"]);

const EXT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".ics": "text/calendar",
  ".vcf": "text/vcard",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".sql": "application/sql",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

const starts = (b: Uint8Array, sig: number[]): boolean => b.length >= sig.length && sig.every((v, i) => b[i] === v);

function sniffBinary(b: Uint8Array): string | null {
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

/** Avoids cutting inside a multi-byte UTF-8 sequence at the end of a bounded sample window. */
function trimIncompleteUtf8Tail(sample: Uint8Array): Uint8Array {
  const n = sample.length;
  if (n === 0) return sample;
  let i = n - 1;
  while (i >= 0 && n - 1 - i < 3 && (sample[i]! & 0xc0) === 0x80) i--;
  if (i < 0) return sample;
  const lead = sample[i]!;
  if (lead < 0x80) return sample;
  const expected = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return n - i < expected ? sample.subarray(0, i) : sample;
}

const UTF8_SAMPLE_BYTES = 256 * 1024;

export function isUtf8Text(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  const window = b.subarray(0, Math.min(b.length, UTF8_SAMPLE_BYTES));
  for (const x of window) if (x === 0) return false;
  const sample = b.length > UTF8_SAMPLE_BYTES ? trimIncompleteUtf8Tail(window) : window;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function mimeFromFilename(filename: string): string | null {
  const m = /(\.[a-z0-9]{1,10})$/i.exec(filename.trim());
  return m ? (EXT_TYPES[m[1]!.toLowerCase()] ?? null) : null;
}

/** A plain type/subtype in lower case, or null. Restricted characters, so it is safe in a header or a quoted command. */
const wellFormed = (m: string | null | undefined): string | null => {
  const base = (m ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const fixed = base === "image/jpg" ? "image/jpeg" : base === "text/x-markdown" ? "text/markdown" : base;
  if (!fixed || TRANSPORT_TYPES.has(fixed)) return null;
  return /^[a-z0-9][a-z0-9.+_-]{0,126}\/[a-z0-9][a-z0-9.+_-]{0,126}$/.test(fixed) ? fixed : null;
};

/** The type an upload command declares: the client's type when well-formed, else application/octet-stream. */
export function declaredUploadType(declared: string | null | undefined): string {
  return wellFormed(declared) ?? "application/octet-stream";
}

/** Whether assistants can read this stored MIME type directly as inline UTF-8 text by default. */
export function isInlineTextType(mime: string | null | undefined): boolean {
  if (!mime) return false;
  if (mime === "text/html") return false;
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/ld+json" || mime === "application/yaml" || mime === "application/x-yaml" || mime === "application/sql";
}

/**
 * The type a file is stored as. PDF, PNG and JPEG come strictly from magic bytes, so a label can never make the
 * Packets page or an assistant render other bytes as a PDF or image. Valid UTF-8 text preserves structured text
 * types (Markdown, CSV, JSON, YAML, HTML, SVG, XML) and defaults to text/plain. Binary files keep their declared
 * or extension-inferred type and fall back to application/octet-stream.
 */
export function detectType(bytes: Uint8Array, declared: string | null | undefined, filename: string): string {
  const sniffed = sniffBinary(bytes);
  if (sniffed) return sniffed;

  const rawDecl = wellFormed(declared);
  const decl = rawDecl && rawDecl !== "application/octet-stream" ? rawDecl : null;
  const ext = mimeFromFilename(filename);

  if (isUtf8Text(bytes)) {
    if (decl === "text/markdown" || (!decl && ext === "text/markdown")) return "text/markdown";
    const candidate = decl && !(READABLE_BINARY_TYPES as readonly string[]).includes(decl) ? decl : ext;
    if (candidate && (candidate.startsWith("text/") || UTF8_ONLY_TYPES.has(candidate))) return candidate;
    return /\.(md|markdown)$/i.test(filename) ? "text/markdown" : "text/plain";
  }

  const candidate = decl ?? ext;
  if (!candidate || candidate.startsWith("text/") || (READABLE_BINARY_TYPES as readonly string[]).includes(candidate) || UTF8_ONLY_TYPES.has(candidate)) {
    return "application/octet-stream";
  }
  return candidate;
}
