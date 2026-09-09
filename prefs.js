import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TIMEOUT_MAX_SECONDS = 30;

function formatSeconds(seconds) {
    const value = Math.round(seconds);
    if (value <= 0)
        return 'Never';
    return value === 1 ? '1 s' : `${value} s`;
}

export default class KeyboardLightTimerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.default_width = 460;
        window.default_height = 380;

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Keyboard backlight',
            description: 'Uses GNOME’s native keyboard brightness control. After the chosen idle time the light turns off, and the previous level is restored when you use the keyboard or mouse again.',
        });
        page.add(group);

        const adjustment = new Gtk.Adjustment({
            lower: 0,
            upper: TIMEOUT_MAX_SECONDS,
            step_increment: 1,
            page_increment: 5,
            value: settings.get_int('timeout-seconds'),
        });

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment,
            digits: 0,
            draw_value: true,
            hexpand: true,
            width_request: 220,
            valign: Gtk.Align.CENTER,
        });
        scale.set_value_pos(Gtk.PositionType.RIGHT);
        scale.set_format_value_func((_scale, value) => formatSeconds(value));

        const scaleRow = new Adw.ActionRow({
            title: 'Turn off after',
            subtitle: '0 is Never — the light stays on until you turn it off.',
            activatable: false,
        });
        scaleRow.add_suffix(scale);
        group.add(scaleRow);

        let syncing = false;
        scale.connect('value-changed', () => {
            if (syncing)
                return;
            settings.set_int('timeout-seconds', Math.round(scale.get_value()));
        });

        settings.connect('changed::timeout-seconds', () => {
            const value = settings.get_int('timeout-seconds');
            if (Math.round(scale.get_value()) === value)
                return;
            syncing = true;
            scale.set_value(value);
            syncing = false;
        });

        const lowOnly = new Adw.SwitchRow({
            title: 'Lowest level only',
            subtitle: 'Keep the backlight at the first on-level (low). Hides the intensity control in Quick Settings. The keyboard hotkey only switches between off and low.',
        });
        settings.bind('low-only', lowOnly, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(lowOnly);
    }
}
