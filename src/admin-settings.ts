/** Admin-only settings panel. Settings are Infisical variables. Only role=admin can access. */

export function adminSettingsPanel(): string {
  return `
<section id="admin_settings" style="border:1px solid #e5e7eb;border-radius:8px;padding:1rem;margin:1rem 0">
  <h2>Admin Settings</h2>
  <p style="color:#6b7280;font-size:.9rem">These controls are admin-only and map to Infisical variables. Changes apply after sync.</p>

  <div style="display:grid;gap:1rem;max-width:480px">
    <label>
      Max new file writes per day
      <input type="number" id="max_file_writes" value="10000" min="0" style="width:100%;padding:.4rem">
    </label>
    <label>
      Max D1 reads per day
      <input type="number" id="max_d1_reads" value="1000000" min="0" style="width:100%;padding:.4rem">
    </label>
    <label>
      Max D1 writes per day
      <input type="number" id="max_d1_writes" value="100000" min="0" style="width:100%;padding:.4rem">
    </label>
    <label>
      Max KV operations per day
      <input type="number" id="max_kv_ops" value="1000000" min="0" style="width:100%;padding:.4rem">
    </label>
    <label>
      Stop all writes when any limit is hit
      <input type="checkbox" id="hard_stop" checked>
    </label>
    <label>
      Optional storage backend
      <select id="storage_backend" style="width:100%;padding:.4rem">
        <option value="r2">Cloudflare R2 (default)</option>
        <option value="b2">Backblaze B2</option>
      </select>
    </label>
    <button id="save_settings" type="button" style="padding:.5rem 1rem;background:#111;color:#fff;border:none;border-radius:4px">Save Settings</button>
  </div>
  <div id="settings_notice" style="margin-top:.75rem;font-size:.9rem"></div>
</section>
`;
}

export function adminSettingsScript(): string {
  return `
<script>
(async function() {
  const notice = document.getElementById('settings_notice');
  async function load() {
    const r = await fetch('/api/admin/settings');
    if (!r.ok) { notice.textContent = 'Admin only.'; return; }
    const s = await r.json();
    document.getElementById('max_file_writes').value = s.maxFileWrites || 10000;
    document.getElementById('max_d1_reads').value = s.maxD1Reads || 1000000;
    document.getElementById('max_d1_writes').value = s.maxD1Writes || 100000;
    document.getElementById('max_kv_ops').value = s.maxKvOps || 1000000;
    document.getElementById('hard_stop').checked = s.hardStop !== false;
    document.getElementById('storage_backend').value = s.storageBackend || 'r2';
  }
  document.getElementById('save_settings').onclick = async () => {
    const body = {
      maxFileWrites: Number(document.getElementById('max_file_writes').value),
      maxD1Reads: Number(document.getElementById('max_d1_reads').value),
      maxD1Writes: Number(document.getElementById('max_d1_writes').value),
      maxKvOps: Number(document.getElementById('max_kv_ops').value),
      hardStop: document.getElementById('hard_stop').checked,
      storageBackend: document.getElementById('storage_backend').value
    };
    const r = await fetch('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    notice.textContent = r.ok ? 'Saved. Synced to Infisical.' : 'Save failed (admin only).';
  };
  load();
})();
</script>
`;
}
