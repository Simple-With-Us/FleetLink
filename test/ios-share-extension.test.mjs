import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertProfileBundle} from '../scripts/ios-install-profiles.mjs';
const read = p => readFileSync(new URL('../'+p, import.meta.url),'utf8');
test('Share extension is embedded, restricted to extension-safe code, and activates for all supported content', () => {
 const p=read('ios/project.yml');
 assert.match(p,/target: FleetLinkShare\s+embed: true/);
 assert.match(p,/APPLICATION_EXTENSION_API_ONLY: YES/);
 for(const type of ['File','Image','Movie','WebURL']) assert.match(p,new RegExp('NSExtensionActivationSupports'+type+'WithMaxCount: 10'));
 assert.match(p,/NSExtensionActivationSupportsText: true/);
 assert.doesNotMatch(p,/TRUEPREDICATE/);
});
test('credentials stay in scoped keychain with migration and logout clearing, never preferences', () => {
 const shared=read('ios/Shared/ShareSession.swift'), session=read('ios/Shared/SessionManager.swift');
 assert.match(shared,/kSecAttrAccessGroup/); assert.match(shared,/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
 assert.doesNotMatch(shared,/UserDefaults/); assert.match(session,/ShareSession.save\(value, origin: origin\)/);
 assert.match(session,/ShareSession.save\(nil\)/);
});
test('preview precedes explicit confirmed post; bounded memory and errors cannot retry automatically', () => {
 const s=read('ios/ShareExtension/ShareViewController.swift');
 assert.match(s,/providers.count <= 10/); assert.match(s,/20 \* 1024 \* 1024/);
 assert.match(s,/while result.count <= remaining/);
 assert.match(s,/remaining - result.count/);
 assert.match(s,/UIPasteboard.general.string = resultLink/);
 assert.match(s,/guard postButton.isEnabled else/);
 assert.match(s,/field\("personal", "true"\)/); assert.match(s,/field\("team_access", "view"\)/);
 assert.match(s,/completed = true/);
 assert.doesNotMatch(s,/UIApplication.shared|openURL|UserDefaults/);
});
test('extension signing checks shared keychain, not unrelated web credential capability', () => {
 const profile=(group)=>`<key>application-identifier</key><string>TEAM.online.fleetlink.ios.Share</string><key>get-task-allow</key><false/><key>keychain-access-groups</key><array><string>${group}</string></array>`;
 assert.doesNotThrow(()=>assertProfileBundle(profile('TEAM.*'),'online.fleetlink.ios.Share'));
 assert.doesNotThrow(()=>assertProfileBundle(profile('TEAM.online.fleetlink.ios'),'online.fleetlink.ios.Share'));
 assert.throws(()=>assertProfileBundle(profile('OTHER.*'),'online.fleetlink.ios.Share'),/shared keychain/);
 assert.throws(()=>assertProfileBundle(profile('TEAM.*'),'online.fleetlink.ios'),/application-identifier/);
});

test('share credential binds validated host and text is bounded before copying', () => {
 const s=read('ios/ShareExtension/ShareViewController.swift');
 assert.match(s,/credential.origin.appending/); assert.match(s,/ShareSession.read\(\) == credential/);
 assert.match(s,/guard text.utf8.count <= maxBytes - total/);
 const session=read('ios/Shared/SessionManager.swift');
 assert.doesNotMatch(session.match(/public var passkeyBearer[\s\S]*?public func adoptBearerToken/)[0],/ShareSession.save/);
 assert.match(read('ios/Shared/ShareSession.swift'),/allowedOrigin/);
});
