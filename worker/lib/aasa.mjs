/**
 * Associated-domain file for passkeys and App Clips.
 * Team ID and bundle ID come from the worker env.  When they are unset the
 * caller keeps the previously deployed document so App Clips do not go blank
 * before those values are approved.
 */
export function appleAppSiteAssociation(env) {
  const team = String(env?.APPLE_TEAM_ID || "").trim();
  const bundle = String(env?.APPLE_BUNDLE_ID || "").trim();
  if (!team || !bundle) return null;
  const appId = `${team}.${bundle}`;
  const clipBundle = String(env?.APPLE_CLIP_BUNDLE_ID || `${bundle}.Clip`).trim();
  const clipId = `${team}.${clipBundle}`;
  return {
    applinks: {
      apps: [],
      details: [
        {
          appIDs: [appId],
          components: [{ "/": "/*", comment: "All artifact shares" }]
        }
      ]
    },
    webcredentials: { apps: [appId] },
    appclips: { apps: [clipId] }
  };
}
