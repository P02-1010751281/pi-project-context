#!/usr/bin/env bash
# Sync this repository's extensions into pi's global extension directory.
#
# This repository is the source of truth; ~/.pi/agent/extensions is a deployment
# copy (that way an unmounted drive cannot take pi's extensions down with it).
# Do not install this repo as a pi package at the same time: two loaded copies make
# pi rename every duplicate command (auto-handoff:1 / :2) and run each hook twice.
# Run this after changing anything under extensions/, then /reload in pi.
#
# Override the target with PI_EXTENSIONS_DIR=/path/to/extensions.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"

# Directories superseded by the merged project-context extension. They are removed
# so pi does not load two copies of the same hooks; user files elsewhere in the
# extensions directory are never touched.
legacy=(session-context memory autolearn auto-handoff _shared)

# A pi *package* that ships this same extension loads beside the deployed copy. pi
# then renames every duplicate command (`auto-handoff:1` / `:2`), so the plain names
# stop resolving and hooks/passes run twice. Warn instead of removing the package.
for settings in "${PI_SETTINGS_FILE:-$HOME/.pi/agent/settings.json}" "$here/.pi/settings.json"; do
	[ -f "$settings" ] || continue
	if sed -n '/"packages"[[:space:]]*:/,/\]/p' "$settings" | grep -q 'project-context'; then
		echo "warn: $settings still installs a pi-project-context package" >&2
		echo "      pi would load it beside $target/project-context and rename" >&2
		echo "      every duplicate command (auto-handoff:1, project-context:2, ...)." >&2
		echo "      Run: pi remove <that-package>   then /reload" >&2
	fi
done

mkdir -p "$target"

managed=""
for dir in "$here"/extensions/*/; do
	name="$(basename "$dir")"
	managed="$managed $name"
	rm -rf "$target/$name"
	cp -R "$dir" "$target/$name"
	echo "synced  $name"
done

for name in "${legacy[@]}"; do
	if [ -d "$target/$name" ]; then
		rm -rf "$target/$name"
		echo "removed legacy $name"
	fi
done

for dir in "$target"/*/; do
	name="$(basename "$dir")"
	case " $managed " in
		*" $name "*) ;;
		*) echo "note: $name exists in $target but is not managed by this repository" ;;
	esac
done

echo
echo "Done. Run /reload in pi to pick up the changes."
