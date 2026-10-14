/**
 * Associated-domain file for passkeys and App Clips.
 * Team ID and bundle ID come from the worker env.  When they are unset the
 * caller keeps the previously deployed document so App Clips do not go blank
 * before those values are approved.
 *
 * The configured bundle is unioned with the ids the site already shipped.
 * Replacing that list dropped online.fleetlink.Clip, which the smart banner
 * still names, and universal links for the older app id stopped opening.
 */

const SHIPPED_APP_BUNDLES = ["online.fleetlink", "online.fleetlink.ios"];
const SHIPPED_CLIP_BUNDLES = ["online.fleetlink.Clip", "online.fleetlink.ios.Clip"];

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function appleAppSiteAssociation(env) {
  const team = String(env?.APPLE_TEAM_ID || "").trim();
  const bundle = String(env?.APPLE_BUNDLE_ID || "").trim();
  if (!team || !bundle) return null;
  const clipBundle = String(env?.APPLE_CLIP_BUNDLE_ID || `${bundle}.Clip`).trim();
  const appIds = unique([bundle, ...SHIPPED_APP_BUNDLES]).map((id) => `${team}.${id}`);
  const clipIds = unique([clipBundle, ...SHIPPED_CLIP_BUNDLES]).map((id) => `${team}.${id}`);
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: appIds,
          components: [{ "/": "/*", comment: "All artifact shares" }]
        }
      ]
    },
    webcredentials: { apps: appIds },
    appclips: { apps: clipIds }
  };
}
