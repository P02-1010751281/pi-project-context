/**
 * User notifications and error text, kept out of the storage modules so they stay host-free.
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	} catch {
		// Notifications must never break a handler; the UI may already be tearing down.
	}
}

/** The message of a thrown value, for user-facing receipts and guards. The error log keeps the
 * stack (`logError` builds its own text) — this helper deliberately drops it. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
