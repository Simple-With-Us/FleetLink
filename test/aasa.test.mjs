import assert from "node:assert/strict";
import test from "node:test";
import { appleAppSiteAssociation } from "../worker/lib/aasa.mjs";

test("aasa keeps the shipped app and clip ids beside the configured bundle", () => {
  assert.equal(appleAppSiteAssociation({}), null);
  const doc = appleAppSiteAssociation({
    APPLE_TEAM_ID: "TEAMID",
    APPLE_BUNDLE_ID: "online.fleetlink.ios"
  });
  assert.deepEqual(doc.applinks.details[0].appIDs, [
    "TEAMID.online.fleetlink.ios",
    "TEAMID.online.fleetlink"
  ]);
  assert.deepEqual(doc.webcredentials.apps, doc.applinks.details[0].appIDs);
  assert.deepEqual(doc.appclips.apps, [
    "TEAMID.online.fleetlink.ios.Clip",
    "TEAMID.online.fleetlink.Clip"
  ]);
});
