#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="keyboard-light-timer@burny"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${EXT_UUID}"

echo "==> Installing ${EXT_UUID}"
mkdir -p "${EXT_DIR}/schemas"

cp "${DIR}/metadata.json" "${EXT_DIR}/"
cp "${DIR}/extension.js" "${EXT_DIR}/"
cp "${DIR}/prefs.js" "${EXT_DIR}/"
cp "${DIR}/schemas/"*.gschema.xml "${EXT_DIR}/schemas/"

echo "==> Compiling GSettings schemas"
glib-compile-schemas "${EXT_DIR}/schemas/"

if command -v gnome-extensions >/dev/null 2>&1; then
    echo "==> Enabling extension"
    # Newly copied files are only picked up after a shell restart; enable still
    # registers it so it appears in Extension Manager / GNOME Extensions.
    gnome-extensions enable "${EXT_UUID}" 2>/dev/null || true
else
    echo "==> gnome-extensions not found; skip enable (install files only)"
fi

echo ""
echo "Installed to: ${EXT_DIR}"
echo ""
echo "It will show up in Extension Manager (or GNOME Extensions) where you can"
echo "enable / disable it. Restart GNOME Shell first so it loads:"
echo "  - X11:     Alt+F2, type r, Enter"
echo "  - Wayland: log out and log back in"
echo ""
echo "To uninstall later:"
echo "  rm -rf \"${EXT_DIR}\""
echo "  gnome-extensions disable ${EXT_UUID}  # optional"
