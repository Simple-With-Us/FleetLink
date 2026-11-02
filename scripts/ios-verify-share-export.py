#!/usr/bin/env python3
"""Verify the freshly exported FleetLink archive without exposing signing secrets."""
import glob, os, pathlib, plistlib, subprocess, zipfile
roots = sorted(glob.glob(os.path.join(os.environ.get('TMPDIR', '/tmp'), 'ios-ship-fleetlink-*')), key=os.path.getmtime)
assert roots, 'No export output found'
root = pathlib.Path(roots[-1])
app = root / 'FleetLink.xcarchive/Products/Applications/FleetLink.app'
share = app / 'PlugIns/FleetLinkShare.appex'
assert app.is_dir() and share.is_dir(), 'Containing app or embedded Share extension missing'
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
for item, bundle in [(app, 'online.fleetlink.ios'), (share, 'online.fleetlink.ios.Share')]:
    info = plistlib.loads((item / 'Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == bundle
    result = subprocess.run(['codesign', '-d', '--entitlements', ':-', str(item)], check=True, capture_output=True)
    raw = result.stdout
    if b'<?xml' not in raw: raw = result.stderr
    ent = plistlib.loads(raw[raw.index(b'<?xml'):])
    assert ent['application-identifier'] == 'CC8UTF7ATG.' + bundle
    assert 'CC8UTF7ATG.online.fleetlink.ios' in ent['keychain-access-groups']
    assert ent.get('get-task-allow') is not True
    if item == share: assert info['NSExtension']['NSExtensionPointIdentifier'] == 'com.apple.share-services'
    print('Verified', bundle, info['CFBundleShortVersionString'], info['CFBundleVersion'], 'signed shared-keychain entitlement')
ipas = list((root / 'export').glob('*.ipa'))
assert len(ipas) == 1, 'Expected one exported IPA'
with zipfile.ZipFile(ipas[0]) as archive:
    assert any('/PlugIns/FleetLinkShare.appex/Info.plist' in name for name in archive.namelist()), 'Exported IPA lost extension'
print('SIGNED_ARCHIVE_AND_IPA_EMBED_VERIFIED')
