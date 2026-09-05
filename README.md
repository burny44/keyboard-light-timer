# Keyboard Light Timer

GNOME Shell extension that adds an idle timeout to the **native** keyboard backlight control in Quick Settings.

- After a period with no keyboard, mouse, or touch input the backlight turns off
- Playback (YouTube, movies, etc.) does **not** keep the light on — only real input counts
- The previous brightness is restored on the next key or mouse event

Compatible with **GNOME Shell 45–50**.

## Features

- Hooks into GNOME’s existing Keyboard Quick Settings menu (no extra panel icon)
- Horizontal timeout slider: **Never** … **30 seconds**
- Uses `org.gnome.SettingsDaemon.Power.Keyboard`, the same brightness interface as the built-in slider
- Preferences window with the same timeout slider

## Install

```bash
git clone https://github.com/burny44/keyboard-light-timer.git
cd keyboard-light-timer
./install.sh
```

Then restart GNOME Shell so it loads:

- **X11:** `Alt+F2`, type `r`, Enter
- **Wayland:** log out and log back in

Enable it in Extension Manager (or GNOME Extensions) if it is not already on.

### Manual install

```bash
UUID=keyboard-light-timer@burny
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST/schemas"
cp metadata.json extension.js prefs.js "$DEST/"
cp schemas/*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas/"
gnome-extensions enable "$UUID"
```

## Usage

1. Open Quick Settings.
2. Expand the **Keyboard** backlight row.
3. Drag the **Timeout** slider.
   - **Never** — light stays on until you turn it off
   - **1–30 s** — light turns off after that much idle time

The same setting is available in the extension’s preferences.

## Uninstall

```bash
rm -rf ~/.local/share/gnome-shell/extensions/keyboard-light-timer@burny
gnome-extensions disable keyboard-light-timer@burny   # optional
```

Restart GNOME Shell afterwards.

## Requirements

- A keyboard backlight that GNOME already exposes (the native Keyboard toggle in Quick Settings)
- `glib-compile-schemas` (from glib2) for install
