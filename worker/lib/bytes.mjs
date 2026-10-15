const encoder = new TextEncoder();

export function bytesToB64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(value) {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomHex(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Prefixed random id, such as usr_3f9a… */
export function newId(prefix, bytes = 10) {
  return `${prefix}_${randomHex(bytes)}`;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash a bearer secret for storage.  The pepper (SESSION_SECRET) means a copy
 * of the database alone cannot be replayed as a list of live credentials.
 */
export function pepperedHash(value, pepper) {
  return sha256Hex(pepper ? `${pepper}\0${value}` : value);
}

/** Constant-time string comparison over SHA-256 digests. */
export async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function hmacHex(key, data) {
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", imported, encoder.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Salted share-password hash: "s1$<salt>$<sha256(salt:password)>". */
export async function hashSharePassword(password) {
  const salt = randomHex(12);
  return `s1$${salt}$${await sha256Hex(`${salt}:${password}`)}`;
}

export async function verifySharePassword(password, stored) {
  if (!password || !stored) return false;
  const parts = String(stored).split("$");
  if (parts.length === 3 && parts[0] === "s1") {
    return safeEqual(await sha256Hex(`${parts[1]}:${password}`), parts[2]);
  }
  // Shares adopted from the old bucket stored an unsalted SHA-256.
  return safeEqual(await sha256Hex(password), String(stored));
}
