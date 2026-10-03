/**
 * Argument completion for this extension's commands.
 *
 * pi hands the text typed after the command name to `getArgumentCompletions` and the command is
 * responsible for filtering it down, so every command that takes arguments has to answer with its
 * own list. These commands take fixed verbs rather than free text, so prefix filtering over a fixed
 * list is all that is needed — no fuzzy matching.
 */

/**
 * Structurally `AutocompleteItem` from pi-tui. Declared here so this module needs no runtime import
 * of a package the extension does not otherwise depend on.
 */
export type ArgumentCompletion = { value: string; label: string; description?: string };

type Choice = { value: string; description?: string };

function toItems(choices: Choice[]): ArgumentCompletion[] {
	return choices.map((choice) => ({
		value: choice.value,
		label: choice.value,
		...(choice.description ? { description: choice.description } : {}),
	}));
}

/** The first word typed after the command name, plus whatever follows it. */
function splitArguments(prefix: string): { head: string; rest: string; hasSpace: boolean } {
	const trimmed = prefix.replace(/^\s+/, "");
	const space = trimmed.search(/\s/);
	if (space === -1) return { head: trimmed, rest: "", hasSpace: false };
	return { head: trimmed.slice(0, space), rest: trimmed.slice(space + 1).replace(/^\s+/, ""), hasSpace: true };
}

function matching(choices: Choice[], typed: string): ArgumentCompletion[] | null {
	const lower = typed.toLowerCase();
	const matches = choices.filter((choice) => choice.value.toLowerCase().startsWith(lower));
	return matches.length > 0 ? toItems(matches) : null;
}

/** Complete the command's first argument. `null` means "no menu for this input". */
export function completeVerbs(prefix: string, choices: Choice[]): ArgumentCompletion[] | null {
	const { hasSpace, head } = splitArguments(prefix);
	if (hasSpace) return null;
	return matching(choices, head);
}

/** Complete the second argument, but only when the first one is already a known verb. */
export function completeValues(prefix: string, head: string, choices: Choice[]): ArgumentCompletion[] | null {
	const parsed = splitArguments(prefix);
	if (!parsed.hasSpace || parsed.head.toLowerCase() !== head.toLowerCase()) return null;
	return matching(choices, parsed.rest);
}
