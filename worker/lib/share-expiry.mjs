export function parseExpireAtMillis(customMetadata) {
  const raw = customMetadata?.expire_at;
  if (raw == null || raw === "") return null;
  const parsed = parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function latestExpireAtMillisFromListed(objects) {
  let latest = null;
  for (const obj of objects || []) {
    const exp = parseExpireAtMillis(obj.customMetadata);
    if (exp == null) continue;
    if (latest == null || exp > latest) latest = exp;
  }
  return latest;
}

export function isExpiredAt(expireAtMillis, now = Date.now()) {
  return expireAtMillis != null && now > expireAtMillis;
}

export function requestPrefersJson(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("application/json");
}
