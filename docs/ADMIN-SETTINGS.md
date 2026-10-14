# Admin-Only App Settings

- Only users with role=admin can view or edit app settings.
- Settings are also stored/managed as Infisical variables (central source of truth).
- Dashboard Admin section is gated on role=admin.
- Includes usage limits, storage backend choice (R2 vs Backblaze), feature flags, etc.
- Non-admins receive 403 on any settings endpoint.

Aligns with fleet-wide Infisical usage and the multi-user role model.