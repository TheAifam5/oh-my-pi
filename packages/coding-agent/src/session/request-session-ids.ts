/**
 * Provider session ids that a session derives for requests outside its own turns (side-channel
 * turns, handoff, advisors), and the way back to the session that owns them.
 */

const SIDE_SEPARATOR = ":side:";

/** Most derived ids remembered for {@link requestOwnerSessionId}; the oldest is forgotten first. */
const MAX_DERIVED_SESSION_IDS = 1_024;

const derivedOwners = new Map<string, string>();

/** The provider session id of a side request of `sessionId` with `lineage` (a request or conversation key). */
export function sideRequestSessionId(sessionId: string, lineage: string): string {
	return `${sessionId}${SIDE_SEPARATOR}${lineage}`;
}

/** Remember that `derived`, a provider session id not built by {@link sideRequestSessionId}, belongs to `owner`. */
export function registerDerivedSessionId(derived: string, owner: string): void {
	derivedOwners.delete(derived);
	derivedOwners.set(derived, owner);
	if (derivedOwners.size > MAX_DERIVED_SESSION_IDS) {
		const oldest = derivedOwners.keys().next().value;
		if (oldest !== undefined) derivedOwners.delete(oldest);
	}
}

/** The session that made a request with provider session id `sessionId`: itself unless derived. */
export function requestOwnerSessionId(sessionId: string): string {
	const registered = derivedOwners.get(sessionId);
	if (registered !== undefined) return registered;
	const side = sessionId.indexOf(SIDE_SEPARATOR);
	return side === -1 ? sessionId : sessionId.slice(0, side);
}
