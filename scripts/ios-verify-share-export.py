#!/usr/bin/env python3
"""Verify the freshly exported FleetLink archive without exposing signing secrets."""
import glob, os, pathlib, plistlib, subprocess, zipfile
def require(value, message):
    if not value: raise SystemExit(message)
roots = sorted(glob.glob(os.path.join(os.environ.get('TMPDIR', '/tmp'), 'ios-ship-fleetlink-*')), key=os.path.getmtime)
require(roots, 'No export output found')
root = pathlib.Path(roots[-1])
app = root / 'FleetLink.xcarchive/Products/Applications/FleetLink.app'
share = app / 'PlugIns/FleetLinkShare.appex'
require(app.is_dir() and share.is_dir(), 'Containing app or embedded Share extension missing')
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
for item, bundle in [(app, 'online.fleetlink.ios'), (share, 'online.fleetlink.ios.Share')]:
    info = plistlib.loads((item / 'Info.plist').read_bytes())
    require(info['CFBundleIdentifier'] == bundle, "Signed archive verification failed: info['CFBundleIdentifier'] == bundle")
    result = subprocess.run(['codesign', '-d', '--entitlements', ':-', str(item)], check=True, capture_output=True)
    raw = result.stdout
    if b'<?xml' not in raw: raw = result.stderr
    ent = plistlib.loads(raw[raw.index(b'<?xml'):])
    require(ent['application-identifier'] == 'CC8UTF7ATG.' + bundle, "Signed archive verification failed: ent['application-identifier'] == 'CC8UTF7ATG.' + bundle")
    require('CC8UTF7ATG.online.fleetlink.ios' in ent['keychain-access-groups'], "Signed archive verification failed: 'CC8UTF7ATG.online.fleetlink.ios' in ent['keychain-access-groups']")
    require(ent.get('get-task-allow') is not True, "Signed archive verification failed: ent.get('get-task-allow') is not True")
    if item == share: require(info['NSExtension']['NSExtensionPointIdentifier'] == 'com.apple.share-services', "Signed archive verification failed: info['NSExtension']['NSExtensionPointIdentifier'] == 'com.apple.share-services'")
    print('Verified', bundle, info['CFBundleShortVersionString'], info['CFBundleVersion'], 'signed shared-keychain entitlement')
ipas = list((root / 'export').glob('*.ipa'))
require(len(ipas) == 1, 'Expected one exported IPA')
with zipfile.ZipFile(ipas[0]) as archive:
    require(any('/PlugIns/FleetLinkShare.appex/Info.plist' in name for name in archive.namelist()), 'Exported IPA lost extension')
print('SIGNED_ARCHIVE_AND_IPA_EMBED_VERIFIED')
