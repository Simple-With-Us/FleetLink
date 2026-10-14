// Admin Settings UI stub (role=admin only)
// Settings are Infisical variables; this panel reads/writes them via the worker.

export function renderAdminSettingsPanel(current: any) {
  return `
<section id="admin-settings">
  <h2>Admin Settings</h2>
  <p class="note">Admin only. Values are stored as Infisical variables.</p>

  <h3>Usage Guards</h3>
  <label>Max D1 reads / day <input type="number" name="MAX_D1_READS" value="${current.MAX_D1_READS || 1000000}"></label>
  <label>Max D1 writes / day <input type="number" name="MAX_D1_WRITES" value="${current.MAX_D1_WRITES || 50000}"></label>
  <label>Max R2 / file writes / day <input type="number" name="MAX_FILE_WRITES" value="${current.MAX_FILE_WRITES || 1000}"></label>
  <label>Max KV operations / day <input type="number" name="MAX_KV_OPS" value="${current.MAX_KV_OPS || 100000}"></label>
  <label><input type="checkbox" name="STOP_ON_LIMIT" ${current.STOP_ON_LIMIT ? 'checked' : ''}> Stop all reads/writes when any limit is hit</label>

  <h3>Storage</h3>
  <label>Optional Backblaze B2 bucket
    <input type="text" name="B2_BUCKET" value="${current.B2_BUCKET || ''}" placeholder="Leave empty to use R2">
  </label>
  <label>B2 Endpoint <input type="text" name="B2_ENDPOINT" value="${current.B2_ENDPOINT || ''}"></label>

  <h3>Auth</h3>
  <label>Admin emails (comma-separated) <input type="text" name="ADMIN_EMAILS" value="${current.ADMIN_EMAILS || ''}"></label>

  <button type="submit">Save Settings</button>
  <p class="status">Current usage: D1 reads ${current.current_d1_reads || 0}, writes ${current.current_d1_writes || 0}</p>
</section>
`;
}
