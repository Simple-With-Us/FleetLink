import { randomId } from "./bytes.mjs";
import { checkUsageGuard, trackUsage } from "./cost-guards.mjs";

const MAX_USER_SHARES = 100;

export async function recordUserShare(env, userId, data) {
  if (!env?.DB || !userId || !data?.slug) return null;
  const cleanSlug = String(data.slug).trim().replace(/^\/+|\/+$/g, "");
  const cleanUrl = String(data.url || "");

  // Admin toggle: If user_shares_mode is configured as "client" (Option 1), skip D1 writes
  if (env.USER_SHARES_MODE === "client") {
    return { id: `ush_${randomId(8)}`, slug: cleanSlug, url: cleanUrl, mode: "client" };
  }

  // Cost guard protection: Refuse D1 writes if 95% cap is reached
  const writeGuard = checkUsageGuard("d1_writes", 2);
  if (!writeGuard.allowed) {
    console.warn(JSON.stringify({
      event: "user_shares_d1_guard_halt",
      message: "D1 writes at 95% cap. Falling back to client-side share ledger.",
      slug: cleanSlug
    }));
    return { id: `ush_${randomId(8)}`, slug: cleanSlug, url: cleanUrl, mode: "client_fallback", guardHalt: true };
  }

  const now = Math.floor(Date.now() / 1000);
  const id = `ush_${randomId(8)}`;
  const mode = data.mode === "redirect" ? "redirect" : "files";
  const targetUrl = data.targetUrl ? String(data.targetUrl) : null;
  const fileCount = Number.isInteger(data.fileCount) && data.fileCount > 0 ? data.fileCount : 1;
  const bytes = Number.isInteger(data.bytes) && data.bytes >= 0 ? data.bytes : 0;
  const passwordProtected = data.passwordProtected ? 1 : 0;
  const expiresAt = data.expiresAt ? String(data.expiresAt) : null;

  try {
    // Delete any existing record for this slug to maintain uniqueness per slug
    await env.DB.prepare("DELETE FROM user_shares WHERE slug = ?").bind(cleanSlug).run();

    // Check count and prune oldest if user exceeds MAX_USER_SHARES
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS total FROM user_shares WHERE user_id = ?").bind(userId).first();
    const total = Number(countRow?.total ?? 0);
    if (total >= MAX_USER_SHARES) {
      await env.DB.prepare(
        `DELETE FROM user_shares WHERE id IN (
          SELECT id FROM user_shares WHERE user_id = ? ORDER BY created_at ASC LIMIT ?
        )`
      ).bind(userId, (total - MAX_USER_SHARES) + 1).run();
    }

    await env.DB.prepare(
      `INSERT INTO user_shares (
        id, user_id, slug, url, mode, target_url, file_count, bytes, password_protected, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      userId,
      cleanSlug,
      cleanUrl,
      mode,
      targetUrl,
      fileCount,
      bytes,
      passwordProtected,
      expiresAt,
      now
    ).run();

    trackUsage("d1_writes", 2);
    return { id, slug: cleanSlug, url: cleanUrl };
  } catch (err) {
    // Fail safe: user share recording is best-effort and must not fail the R2 upload itself
    console.error(JSON.stringify({ event: "record_user_share_failed", error: err?.message || String(err) }));
    return null;
  }
}

export async function listUserShares(env, userId) {
  if (!env?.DB || !userId) return [];
  const readGuard = checkUsageGuard("d1_reads", 1);
  if (!readGuard.allowed) {
    console.warn(JSON.stringify({
      event: "user_shares_d1_read_guard_halt",
      message: "D1 reads at 95% cap. Skipping database user share listing."
    }));
    return [];
  }
  try {
    trackUsage("d1_reads", 1);
    const res = await env.DB.prepare(
      "SELECT * FROM user_shares WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
    ).bind(userId).all();
    return (res.results || []).map((row) => ({
      id: row.id,
      slug: row.slug,
      url: row.url,
      mode: row.mode,
      target_url: row.target_url,
      file_count: row.file_count,
      files: row.file_count,
      bytes: row.bytes,
      password_protected: row.password_protected === 1,
      expires_at: row.expires_at || "never",
      created_at: new Date(row.created_at * 1000).toISOString()
    }));
  } catch (err) {
    console.error(JSON.stringify({ event: "list_user_shares_failed", error: err?.message || String(err) }));
    return [];
  }
}

export async function deleteUserShare(env, slug, userId = null) {
  if (!env?.DB || !slug) return false;
  const cleanSlug = String(slug).trim().replace(/^\/+|\/+$/g, "");
  const writeGuard = checkUsageGuard("d1_writes", 1);
  if (!writeGuard.allowed) return false;
  try {
    trackUsage("d1_writes", 1);
    let res;
    if (userId) {
      res = await env.DB.prepare("DELETE FROM user_shares WHERE slug = ? AND user_id = ?").bind(cleanSlug, userId).run();
    } else {
      res = await env.DB.prepare("DELETE FROM user_shares WHERE slug = ?").bind(cleanSlug).run();
    }
    return (res.meta?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function getUserShare(env, slug) {
  if (!env?.DB || !slug) return null;
  const cleanSlug = String(slug).trim().replace(/^\/+|\/+$/g, "");
  try {
    return await env.DB.prepare("SELECT * FROM user_shares WHERE slug = ?").bind(cleanSlug).first();
  } catch {
    return null;
  }
}
