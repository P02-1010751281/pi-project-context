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
