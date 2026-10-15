import { z } from "zod";

const settingsValueSchema = z.union([z.string(), z.number(), z.null()]);

// Request body for PUT /api/admin/settings.  Unknown top-level fields are refused.
export const SettingsUpdateBody = z.object({
  values: z.record(z.string(), settingsValueSchema)
}).strict();

// Persisted settings:overrides document.  _v is the compare-and-swap version.
export const SettingsOverridesDocument = z.object({
  _v: z.number().int().nonnegative().optional(),
  storage_binding: settingsValueSchema.optional(),
  share_hosts: settingsValueSchema.optional(),
  default_share_host: settingsValueSchema.optional(),
  guest_max_files: settingsValueSchema.optional(),
  guest_max_file_bytes: settingsValueSchema.optional(),
  guest_max_batch_bytes: settingsValueSchema.optional(),
  guest_file_ttl_seconds: settingsValueSchema.optional(),
  guest_redirect_ttl_seconds: settingsValueSchema.optional(),
  user_shares_mode: settingsValueSchema.optional()
}).strict();
