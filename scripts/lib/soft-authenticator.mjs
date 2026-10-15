/**
 * A software passkey (ES256, "none" attestation) for tests and the production
 * smoke check.  It produces the same JSON a browser sends, so the worker's real
 * WebAuthn verification runs against it.
 */
import { createHash, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function sha256(bytes) {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** Minimal CBOR encoder: unsigned and negative ints, byte strings, text, maps. */
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    if (n < 65536) return [(major << 5) | 25, n >> 8, n & 0xff];
    return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Map) {
    const out = head(5, value.size);
    for (const [k, v] of value) out.push(...cbor(k), ...cbor(v));
    return out;
  }
  throw new Error("cbor: unsupported value");
}

/** DER-encode a raw r||s P-256 signature, as WebAuthn requires. */
function derSignature(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = Uint8Array.of(0, ...v);
    return [0x02, v.length, ...v];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

export class SoftAuthenticator {
  constructor({ origin = "https://fleetlink.online", rpId = "fleetlink.online" } = {}) {
    this.origin = origin;
    this.rpId = rpId;
    this.credentials = new Map();
  }

  async create(options, { origin = this.origin } = {}) {
    const keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await subtle.exportKey("jwk", keys.publicKey);
    const id = webcrypto.getRandomValues(new Uint8Array(32));
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]]);
    const rpHash = sha256(new TextEncoder().encode(options.rp?.id || this.rpId));
    const authData = Uint8Array.of(
      ...rpHash,
      0x45,
      0, 0, 0, 0,
      ...new Uint8Array(16),
      0, id.length,
      ...id,
      ...cbor(cose)
    );
    const attestation = new Uint8Array(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const credentialId = b64url(id);
    this.credentials.set(credentialId, { privateKey: keys.privateKey, counter: 0, userHandle: options.user?.id, rpId: options.rp?.id || this.rpId });
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestation), transports: ["internal"] },
      clientExtensionResults: {}
    };
  }

  async get(options, { origin = this.origin, credentialId = null, counterStep = 1 } = {}) {
    const allowed = (options.allowCredentials || []).map((c) => c.id);
    const id = credentialId || allowed.find((c) => this.credentials.has(c)) || [...this.credentials.keys()][0];
    const cred = this.credentials.get(id);
    if (!cred) throw new Error("no credential");
    cred.counter += counterStep;
    const rpHash = sha256(new TextEncoder().encode(options.rpId || cred.rpId));
    const authData = Uint8Array.of(...rpHash, 0x05, (cred.counter >>> 24) & 0xff, (cred.counter >> 16) & 0xff, (cred.counter >> 8) & 0xff, cred.counter & 0xff);
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signed = Uint8Array.of(...authData, ...sha256(clientData));
    const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cred.privateKey, signed));
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        userHandle: cred.userHandle
      },
      clientExtensionResults: {}
    };
  }
}
