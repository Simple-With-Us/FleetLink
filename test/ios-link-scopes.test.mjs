import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const model = readFileSync(new URL('../ios/Shared/PortalModel.swift', import.meta.url), 'utf8');
const view = readFileSync(new URL('../ios/App/PortalView.swift', import.meta.url), 'utf8');
test('iOS exposes only permission-bounded scopes, not admin all', () => {
  assert.match(model, /case mine, teams, bots/);
  assert.match(view, /Picker\("Show links", selection: \$portalManager.scope\)/);
  assert.match(view, /\.onChange\(of: portalManager.scope\)/);
  assert.doesNotMatch(model, /scope=all/);
});
test('selected scope follows cursor pages before publishing a complete list', () => {
  assert.match(model, /name: "scope", value: requestedScope.rawValue/);
  assert.match(model, /name: "before", value: cursor/);
  assert.match(model, /while cursor != nil/);
  assert.match(model, /seenCursors.insert\(cursor\).inserted/);
  assert.match(model, /seenSlugs.insert\(share.slug\).inserted/);
  assert.match(model, /sharesRequestID == requestID/);
  assert.match(model, /shares = loaded/);
});
test('existing sorting has an accessible visible control and keeps Newest default', () => {
  assert.match(view, /sortMode: ShareSort = .newest/);
  for (const option of ['Newest', 'Expiring first', 'Name', 'Largest']) assert.ok(view.includes(`= "${option}"`));
  assert.match(view, /Label\("Sort", systemImage: "arrow.up.arrow.down"\)/);
  assert.match(view, /accessibilityLabel\("Sort links"\)/);
});
test('team rows fail closed on missing permissions and gate destructive menus', () => {
  assert.match(model, /can_manage: share.can_manage \?\? false/);
  assert.match(model, /can_edit: share.can_edit \?\? false/);
  assert.ok((view.match(/if share.can_manage == true/g) ?? []).length >= 4);
  assert.match(view, /if share.can_edit == true \|\| share.can_manage == true/);
});
