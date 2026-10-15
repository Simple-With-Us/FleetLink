/** An in-memory R2 bucket with the parts of the API the worker uses. */
import { createHash } from "node:crypto";

async function toBytes(body) {
  if (body == null) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
  if (typeof body.getReader === "function") return new Uint8Array(await new Response(body).arrayBuffer());
  throw new Error("unsupported body");
}

function headersObject(h) {
  if (!h) return {};
  if (typeof h.get === "function") {
    return { range: h.get("range"), ifNoneMatch: h.get("if-none-match") };
  }
  return h;
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m) return null;
  if (m[1] === "" && m[2] !== "") {
    const suffix = Math.min(Number(m[2]), size);
    return { offset: size - suffix, length: suffix };
  }
  const offset = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (offset >= size || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

export class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.calls = 0;
  }

  meta(key, record) {
    return {
      key,
      size: record.bytes.byteLength,
      etag: record.etag,
      httpEtag: `"${record.etag}"`,
      uploaded: record.uploaded,
      httpMetadata: { ...record.httpMetadata },
      customMetadata: { ...record.customMetadata },
      writeHttpMetadata(headers) {
        if (record.httpMetadata?.contentType) headers.set("content-type", record.httpMetadata.contentType);
      }
    };
  }

  async put(key, body, options = {}) {
    this.calls++;
    const bytes = await toBytes(body);
    const record = {
      bytes,
      etag: createHash("md5").update(bytes).digest("hex"),
      uploaded: new Date(),
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {}
    };
    this.objects.set(key, record);
    return this.meta(key, record);
  }

  async head(key) {
    this.calls++;
    const record = this.objects.get(key);
    return record ? this.meta(key, record) : null;
  }

  async get(key, options = {}) {
    this.calls++;
    const record = this.objects.get(key);
    if (!record) return null;
    const base = this.meta(key, record);
    const only = headersObject(options.onlyIf);
    if (only.ifNoneMatch && only.ifNoneMatch.replace(/"/g, "") === record.etag) return base;
    let bytes = record.bytes;
    let range;
    const asked = headersObject(options.range).range;
    if (asked) {
      range = parseRange(asked, bytes.byteLength);
      if (range) bytes = bytes.slice(range.offset, range.offset + range.length);
    }
    return {
      ...base,
      range,
      body: new Response(bytes).body,
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    };
  }

  async delete(keys) {
    this.calls++;
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
    this.calls++;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const entries = [];
    const prefixes = new Set();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      if (delimiter && rest.includes(delimiter)) {
        const p = prefix + rest.slice(0, rest.indexOf(delimiter) + delimiter.length);
        if (!prefixes.has(p)) {
          prefixes.add(p);
          entries.push({ type: "prefix", value: p });
        }
      } else {
        entries.push({ type: "object", value: key });
      }
    }
    const start = cursor ? Number(cursor) : 0;
    const page = entries.slice(start, start + limit);
    const truncated = start + limit < entries.length;
    return {
      objects: page.filter((e) => e.type === "object").map((e) => this.meta(e.value, this.objects.get(e.value))),
      delimitedPrefixes: page.filter((e) => e.type === "prefix").map((e) => e.value),
      truncated,
      cursor: truncated ? String(start + limit) : undefined
    };
  }

  keys() {
    return [...this.objects.keys()].sort();
  }
}
