// Admin Settings UI stub (role=admin only)
// Settings are Infisical variables.
// Includes theme (default system), usage guards, storage, MCP config.

export function renderAdminSettingsPanel(current: any) {
  return `
<section id="admin-settings">
  <div class="header">
    <h2>Admin Settings</h2>
    <label class="theme-toggle">
      Theme
      <select name="THEME" id="theme-select">
        <option value="system" ${(!current.THEME || current.THEME === 'system') ? 'selected' : ''}>System</option>
        <option value="light" ${current.THEME === 'light' ? 'selected' : ''}>Light</option>
        <option value="dark" ${current.THEME === 'dark' ? 'selected' : ''}>Dark</option>
      </select>
    </label>
  </div>
  <p class="note">Admin only. Values are stored as Infisical variables.</p>

  <h3>Usage Guards</h3>
  <label>Max D1 reads / day <input type="number" name="MAX_D1_READS" value="${current.MAX_D1_READS || 1000000}"></label>
  <label>Max D1 writes / day <input type="number" name="MAX_D1_WRITES" value="${current.MAX_D1_WRITES || 50000}"></label>
  <label>Max file writes / day <input type="number" name="MAX_FILE_WRITES" value="${current.MAX_FILE_WRITES || 1000}"></label>
  <label>Max KV ops / day <input type="number" name="MAX_KV_OPS" value="${current.MAX_KV_OPS || 100000}"></label>
  <label><input type="checkbox" name="STOP_ON_LIMIT" ${current.STOP_ON_LIMIT ? 'checked' : ''}> Stop all activity when any limit is hit</label>

  <h3>Storage</h3>
  <label>Optional Backblaze B2 bucket <input type="text" name="B2_BUCKET" value="${current.B2_BUCKET || ''}" placeholder="Leave empty for R2"></label>
  <label>B2 Endpoint <input type="text" name="B2_ENDPOINT" value="${current.B2_ENDPOINT || ''}"></label>

  <h3>MCP</h3>
  <label><input type="checkbox" name="MCP_ENABLED" ${current.MCP_ENABLED !== false ? 'checked' : ''}> Enable MCP endpoint</label>
  <label>MCP path <input type="text" name="MCP_PATH" value="${current.MCP_PATH || '/mcp'}"></label>
  <label><input type="checkbox" name="MCP_REQUIRE_TOKEN" ${current.MCP_REQUIRE_TOKEN !== false ? 'checked' : ''}> Require user agent token</label>

  <h3>Auth</h3>
  <label>Admin emails <input type="text" name="ADMIN_EMAILS" value="${current.ADMIN_EMAILS || ''}"></label>

  <button type="submit">Save Settings</button>
  <p class="status">Current usage: D1 reads ${current.current_d1_reads || 0}</p>
</section>
<script>
  const themeSelect = document.getElementById('theme-select');
  function applyTheme(theme) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }
  applyTheme(themeSelect.value);
  themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
</script>
`;
}
