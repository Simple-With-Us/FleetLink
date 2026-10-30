import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const view = readFileSync(new URL('../ios/App/CreateSlugView.swift', import.meta.url), 'utf8');
const app = readFileSync(new URL('../ios/App/FleetLinkApp.swift', import.meta.url), 'utf8');
test('the slug is explicit and visible before mode-specific content', () => {
  assert.match(view, /Text\("Link slug"\)/);
  assert.match(view, /TextField\("Slug \(optional\)"/);
  assert.ok(view.indexOf('Text("Link slug")') < view.indexOf('Section("Web address")'));
  assert.match(view, /not the preview title or file name/);
  assert.match(view, /selectedDomain\).*slugPreview/);
  assert.match(view, /customSlug: slugToUse/);
});
test('cancel and done return to Links and discard the finished or abandoned form', () => {
  assert.match(view, /Button\(createdURLString == nil \? "Cancel" : "Done"\)/);
  assert.match(view, /onClose\(\)/);
  assert.match(app, /onClose: \{\s*selectedTab = 0\s*creationID = UUID\(\)/);
  assert.match(app, /\.id\(creationID\)/);
  assert.match(view, /Text\(hasCopied \? "Copied" : "Copy link"\)/);
  assert.match(view, /onSelectArtifact\(url\)/);
});
test('success hides the editor and cannot publish twice; in-flight edits and exit are disabled', () => {
  assert.match(view, /if createdURLString == nil \{\s*Section\("What to share"\)/);
  assert.match(view, /guard !isSubmitting, createdURLString == nil, isFormValid else \{ return \}/);
  assert.equal((view.match(/\.disabled\(isSubmitting\)/g) ?? []).length, 2);
});

test('preview and submission share one normalized slug', () => {
  assert.match(view, /private var normalizedSlug: String/);
  assert.match(view, /normalizedSlug.isEmpty \? "<automatic-slug>" : normalizedSlug/);
  assert.match(view, /let slugToUse = normalizedSlug.isEmpty \? nil : normalizedSlug/);
});
