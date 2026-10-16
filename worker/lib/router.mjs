import { assertSameOrigin, requireAdmin, resolvePrincipal } from "./auth.mjs";
import { forbidden, unauthorized } from "./http.mjs";
import { loadSettings } from "./settings.mjs";

/**
 * A small method-and-path router.  Patterns use ":name" for one segment and
 * "*name" for the rest of the path.  HEAD falls back to GET routes.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  on(method, pattern, handler) {
    const names = [];
    const source = pattern
      .split("/")
      .map((part) => {
        if (part.startsWith(":")) {
          names.push(part.slice(1));
          return "([^/]+)";
        }
        if (part.startsWith("*")) {
          names.push(part.slice(1));
          return "(.+)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), names, handler });
    return this;
  }

  match(method, pathname) {
    const methods = method === "HEAD" ? ["HEAD", "GET"] : [method];
    let pathMatched = false;
    for (const candidate of methods) {
      for (const route of this.routes) {
        const m = route.regex.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== candidate && route.method !== "*") continue;
        const params = {};
        route.names.forEach((name, i) => {
          try {
            params[name] = decodeURIComponent(m[i + 1]);
          } catch {
            params[name] = m[i + 1];
          }
        });
        return { handler: route.handler, params };
      }
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/**
 * Per-request context.  The principal is resolved at most once, and the first
 * resolution of a cookie credential on a write enforces the same-origin rule.
 */
export function requestContext(request, env, exec, deps = {}) {
  const url = new URL(request.url);
  let principalPromise = null;
  let settingsPromise = null;
  const ctx = {
    request,
    env,
    exec,
    url,
    deps,
    params: {},
    async principal() {
      if (!principalPromise) {
        principalPromise = resolvePrincipal(request, env).then((principal) => {
          assertSameOrigin(request, principal);
          return principal;
        });
      }
      return principalPromise;
    },
    async auth() {
      const principal = await ctx.principal();
      if (!principal) throw unauthorized();
      return principal;
    },
    /** Account management needs a person: a passkey session or the operator secret, not an API token. */
    async person() {
      const principal = await ctx.auth();
      if (principal.kind === "token") throw forbidden("API tokens cannot manage the account.  Sign in with your passkey.");
      if (principal.kind === "agent") throw forbidden("Agent accounts cannot manage the account.  A person signs in with a passkey to do that.");
      return principal;
    },
    async admin() {
      return requireAdmin(await ctx.principal());
    },
    settings() {
      if (!settingsPromise) settingsPromise = loadSettings(env);
      return settingsPromise;
    },
    async shareOrigin() {
      const settings = await ctx.settings();
      return `https://${settings.default_share_host}`;
    },
    waitUntil(promise) {
      if (exec?.waitUntil) exec.waitUntil(promise.catch(() => {}));
      else promise.catch(() => {});
    }
  };
  return ctx;
}
