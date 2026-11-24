#!/bin/sh
set -eu
native_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mode=app
if [ "${1:-}" = "--test" ]; then
    mode=test
    shift
fi
build_dir="${1:-$native_dir/.build}"
mkdir -p "$build_dir"
staging=$(mktemp -d "$build_dir/staging.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
set -- -O -sdk "$(xcrun --sdk macosx --show-sdk-path)" -module-cache-path "$build_dir/swift-cache"
compiler=$(xcrun --find swiftc)
include_dir="$(dirname "$(dirname "$compiler")")/include/swift"
old_map="$include_dir/module.modulemap"
new_map="$include_dir/bridging.modulemap"
# Older Command Line Tools can leave a second SwiftBridging declaration behind.
# Present an empty old map to this compilation without touching the toolchain.
if [ -f "$old_map" ] && [ -f "$new_map" ] &&
   grep -q 'module SwiftBridging' "$old_map" && grep -q 'module SwiftBridging' "$new_map"; then
    overlay_dir="$build_dir/swift-overlay"
    mkdir -p "$overlay_dir"
    : > "$overlay_dir/empty.modulemap"
    /usr/bin/python3 - "$old_map" "$overlay_dir" <<'PYOVERLAY'
import json
from pathlib import Path
import sys
path, directory = sys.argv[1:]
folder = Path(directory).resolve()
(folder / "overlay.json").write_text(json.dumps({
    "version": 0, "case-sensitive": "false",
    "roots": [{"type": "file", "name": path, "external-contents": str(folder / "empty.modulemap")}],
}), encoding="utf-8")
PYOVERLAY
    set -- "$@" -vfsoverlay "$overlay_dir/overlay.json" -Xcc -ivfsoverlay -Xcc "$overlay_dir/overlay.json"
fi
if [ "$mode" = test ]; then
    "$compiler" "$@" "$native_dir/CalendarProtocol.swift" "$native_dir/ProtocolTests.swift" \
        -o "$staging/protocol-tests"
    "$staging/protocol-tests"
    exit
fi
bundle="$staging/Small Plan Calendar.app"
mkdir -p "$bundle/Contents/MacOS"
cp "$native_dir/Info.plist" "$bundle/Contents/Info.plist"
"$compiler" "$@" -framework EventKit \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$native_dir/Info.plist" \
    "$native_dir/CalendarProtocol.swift" "$native_dir/CalendarHelper.swift" \
    -o "$bundle/Contents/MacOS/SmallPlanCalendar"
codesign --sign - --identifier app.smallplan.calendar "$bundle"
codesign --verify --strict "$bundle"
destination="$build_dir/Small Plan Calendar.app"
# Keep registry and locks at the build root. An interrupted rebuild preserves them.
if [ -e "$destination" ]; then
    mv "$destination" "$staging/previous.app"
fi
if ! mv "$bundle" "$destination"; then
    if [ -e "$staging/previous.app" ]; then
        mv "$staging/previous.app" "$destination"
    fi
    exit 1
fi
