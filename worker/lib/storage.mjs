/** R2 access.  D1 says what exists and who owns it; R2 only holds bytes. */

export const STORAGE_PREFIX = "fl2/";
const DELETE_BATCH = 1000;

export function bucket(env) {
  const b = env?.FLEET_SHARES;
  if (!b) throw new Error("R2 binding FLEET_SHARES is missing.");
  return b;
}

export function objectKey(shareId, path) {
  return `${STORAGE_PREFIX}${shareId}/${path}`;
}

export async function putObject(env, key, body, { contentType, size } = {}) {
  const options = { httpMetadata: contentType ? { contentType } : undefined };
  let payload = body;
  // R2 needs a known length for a stream.  A Content-Length request body has one;
  // anything else is wrapped so the length is declared up front.
  if (size != null && body && typeof body.pipeTo === "function" && typeof FixedLengthStream === "function") {
    const fixed = new FixedLengthStream(size);
    body.pipeTo(fixed.writable).catch(() => {});
    payload = fixed.readable;
  }
  return bucket(env).put(key, payload, options);
}

export async function deleteKeys(env, keys) {
  const list = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < list.length; i += DELETE_BATCH) {
    await bucket(env).delete(list.slice(i, i + DELETE_BATCH));
  }
  return list.length;
}

/** Fetch an object, honoring Range and conditional headers from the request. */
export async function getObject(env, key, request) {
  const options = {};
  if (request) {
    if (request.headers.has("range")) options.range = request.headers;
    if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) options.onlyIf = request.headers;
  }
  return bucket(env).get(key, options);
}
