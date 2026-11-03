/**
 * Agent accounts: the fleet's AI seats, each with its own FleetLink account.
 *
 * A bot account is created explicitly by its manager through the bots API
 * (worker/lib/api/bots.mjs); presenting a seat name creates nothing.  Every
 * bot authenticates with its own API token (worker/lib/tokens.mjs), minted
 * by its manager or by the bot itself through POST /api/agent/token, and
 * recorded for the seat in the MCP-side assignment registry (Infisical
 * /fleetlink, FLEETLINK_TOKEN_<SEAT>).  There is no shared agent credential:
 * a seat with no bot account and no token has no FleetLink access.
 *
 * Every agent account is an admin of the Fleet team, sits under the fleet
 * owner (fleet.mjs), and works with the widest limits (shares.mjs,
 * fullLimits) unless its limit mode says otherwise (auth.mjs,
 * agentLimitsResolution).  Its new shares land in the Fleet team with edit
 * access unless it asks for a personal one, so bots and the owner edit and
 * overwrite each other's work there.
 *
 * Agent accounts never sign in with a passkey, never act as site admins, and
 * cannot manage the account.  Their manager or an admin disables one.
 */

/** The shape of a fleet seat name (JET, GROK-WEB, GB-TRADER). */
export const SEAT = /^[A-Z][A-Z0-9-]{0,22}[A-Z0-9]$/;
