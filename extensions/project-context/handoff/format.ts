/**
 * Number/percent/token formatting and reply cleanup shared by the receipts and the prompt.
 */

export function fmtTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
}

export function fmtPct(percent: number): string {
	return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export function cleanHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const cleaned: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") cleaned[key] = value;
	}
	return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}
