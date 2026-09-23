import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';
const TIMEOUT_MAX_SECONDS = 30;

// GNOME disables and re-enables extensions around the lock screen; the
// startup action must only run once per shell session.
let startupHandled = false;

function loadInterfaceXML(iface) {
    const uri = `resource:///org/gnome/shell/dbus-interfaces/${iface}.xml`;
    const file = Gio.File.new_for_uri(uri);
    try {
        const [, bytes] = file.load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.error(`Keyboard Light Timer: failed to load ${iface}: ${e.message}`);
        return null;
    }
}

const BrightnessInterface = loadInterfaceXML('org.gnome.SettingsDaemon.Power.Keyboard');
const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessInterface);

function formatTimeout(seconds) {
    if (seconds <= 0)
        return 'Never';
    return seconds === 1 ? '1 s' : `${seconds} s`;
}

const TimeoutSliderItem = GObject.registerClass(
class TimeoutSliderItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({
            activate: false,
            style_class: 'keyboard-brightness-item',
        });

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style: 'spacing: 6px;',
        });

        const header = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 12px;',
        });

        this._title = new St.Label({
            text: 'Timeout',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._valueLabel = new St.Label({
            text: formatTimeout(0),
            y_align: Clutter.ActorAlign.CENTER,
        });

        header.add_child(this._title);
        header.add_child(this._valueLabel);

        this._slider = new Slider(0);
        this._slider.accessible_name = 'Keyboard backlight timeout';

        box.add_child(header);
        box.add_child(this._slider);
        this.add_child(box);
    }

    get seconds() {
        return Math.round(this._slider.value * TIMEOUT_MAX_SECONDS);
    }

    setSeconds(seconds, emit) {
        const clamped = Math.max(0, Math.min(TIMEOUT_MAX_SECONDS, Math.round(seconds)));
        this._valueLabel.text = formatTimeout(clamped);

        const next = TIMEOUT_MAX_SECONDS === 0 ? 0 : clamped / TIMEOUT_MAX_SECONDS;
        if (Math.abs(this._slider.value - next) < 0.001)
            return;

        if (!emit && this._sliderChangedId)
            this._slider.block_signal_handler(this._sliderChangedId);
        this._slider.value = next;
        if (!emit && this._sliderChangedId)
            this._slider.unblock_signal_handler(this._sliderChangedId);
    }
});

export default class KeyboardLightTimerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dimmedByUs = false;
        this._savedBrightness = null;
        this._lastBrightness = null;
        this._ignoreChanges = false;
        this._ignoreSource = 0;
        this._echoBrightness = null;
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._injectSource = 0;
        this._injectTries = 0;
        this._sliderItem = null;
        this._separator = null;
        this._menuItems = [];
        this._toggleHooked = false;
        this._osdHooked = false;

        this._idleMonitor = global.backend.get_core_idle_monitor();

        this._proxy = new BrightnessProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
            (proxy, error) => {
                if (error) {
                    console.error(`Keyboard Light Timer: ${error.message}`);
                    return;
                }
                this._onProxyReady();
            });
    }

    disable() {
        this._clearWatches();

        if (this._injectSource) {
            GLib.source_remove(this._injectSource);
            this._injectSource = 0;
        }
        if (this._ignoreSource) {
            GLib.source_remove(this._ignoreSource);
            this._ignoreSource = 0;
        }

        this._removeMenuItems();
        this._unhookNativeToggle();
        this._unhookOsd();

        if (this._dimmedByUs && this._savedBrightness > 0 && this._proxy) {
            try {
                this._proxy.Brightness = this._savedBrightness;
            } catch (_e) {
                // Session may already be tearing down.
            }
        }

        this._dimmedByUs = false;
        this._ignoreChanges = false;
        this._echoBrightness = null;

        this._proxy?.disconnectObject(this);
        this._proxy = null;

        this._settings?.disconnectObject(this);
        this._settings = null;

        this._idleMonitor = null;
        this._savedBrightness = null;
        this._lastBrightness = null;
    }

    _onProxyReady() {
        this._proxy.connectObject(
            'g-properties-changed',
            (_proxy, changed) => {
                const unpacked = changed.deep_unpack();
                if ('Brightness' in unpacked)
                    this._onBrightnessChanged(this._proxy.Brightness);
            },
            this
        );

        this._settings.connectObject(
            'changed::timeout-seconds',
            () => {
                this._syncSlider();
                this._schedule();
            },
            'changed::low-only',
            () => this._onLowOnlyChanged(),
            this
        );

        const brightness = this._proxy.Brightness;
        if (Number.isInteger(brightness) && brightness >= 0) {
            this._lastBrightness = brightness;
            if (brightness > 0)
                this._savedBrightness = brightness;
        }

        this._applyStartupBrightness();

        this._injectMenu();
        this._syncLowOnlyHooks();
        this._schedule();
    }

    _applyStartupBrightness() {
        if (startupHandled)
            return;
        startupHandled = true;

        let target = this._settings.get_int('last-brightness');
        if (target < 0) {
            this._rememberBrightness(this._proxy.Brightness);
            return;
        }
        if (target > 0 && this._isLowOnly())
            target = this._getLowLevel();
        if (this._proxy.Brightness === target)
            return;

        this._setBrightness(target);
        if (target > 0)
            this._savedBrightness = target;
    }

    _rememberBrightness(brightness) {
        if (!this._settings || brightness < 0)
            return;
        if (this._settings.get_int('last-brightness') !== brightness)
            this._settings.set_int('last-brightness', brightness);
    }

    _getKeyboardToggle() {
        const indicator = Main.panel.statusArea.quickSettings?._backlight;
        return indicator?.quickSettingsItems?.[0] ?? null;
    }

    _injectMenu() {
        const toggle = this._getKeyboardToggle();
        if (!toggle?.menu) {
            if (this._injectTries >= 10)
                return;
            this._injectTries++;
            this._injectSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._injectSource = 0;
                this._injectMenu();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        this._removeMenuItems();

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        toggle.menu.addMenuItem(this._separator);
        this._menuItems.push(this._separator);

        this._sliderItem = new TimeoutSliderItem();
        this._sliderItem._sliderChangedId = this._sliderItem._slider.connect('notify::value', () => {
            const seconds = this._sliderItem.seconds;
            this._sliderItem._valueLabel.text = formatTimeout(seconds);
            if (this._settings.get_int('timeout-seconds') !== seconds)
                this._settings.set_int('timeout-seconds', seconds);
        });
        toggle.menu.addMenuItem(this._sliderItem);
        this._menuItems.push(this._sliderItem);

        this._syncSlider();
        this._syncLowOnlyHooks();
    }

    _removeMenuItems() {
        for (const item of this._menuItems)
            item.destroy();
        this._menuItems = [];
        this._sliderItem = null;
        this._separator = null;
    }

    _syncSlider() {
        if (!this._sliderItem)
            return;
        this._sliderItem.setSeconds(this._settings.get_int('timeout-seconds'), false);
    }

    _isLowOnly() {
        return this._settings?.get_boolean('low-only') === true;
    }

    _getLowLevel() {
        const steps = this._proxy?.Steps;
        if (Number.isInteger(steps) && steps > 1)
            return Math.max(1, Math.round(100 / (steps - 1)));
        return 33;
    }

    _onLowOnlyChanged() {
        this._syncLowOnlyHooks();
        if (this._savedBrightness > 0 && this._isLowOnly())
            this._savedBrightness = this._getLowLevel();
        this._schedule();
    }

    _syncLowOnlyHooks() {
        if (this._isLowOnly()) {
            this._hookNativeToggle();
            this._hookOsd();
            this._applyLowOnlyUi();
            this._clampToLowIfNeeded();
            return;
        }

        this._unhookOsd();
        this._unhookNativeToggle();
        this._restoreNativeLevelsUi();
    }

    _restoreNativeLevelsUi() {
        const toggle = this._getKeyboardToggle();
        if (!toggle)
            return;

        try {
            toggle._sync();
        } catch (_e) {
            // Native widget may already be gone.
        }

        const steps = this._proxy?.Steps;
        const useSlider = Number.isInteger(steps) && steps >= 4;
        if (toggle._sliderItem)
            toggle._sliderItem.visible = useSlider;
        if (toggle._discreteItem)
            toggle._discreteItem.visible = !useSlider;
    }

    _clampToLowIfNeeded() {
        if (!this._isLowOnly() || !this._proxy)
            return;
        const brightness = this._proxy.Brightness;
        if (!Number.isInteger(brightness) || brightness <= 0)
            return;
        const low = this._getLowLevel();
        if (brightness > low)
            this._setBrightness(low);
    }

    _hookNativeToggle() {
        const toggle = this._getKeyboardToggle();
        if (!toggle || this._toggleHooked)
            return;

        this._toggleHooked = true;
        toggle._kltOriginalSync = toggle._sync.bind(toggle);
        toggle._sync = () => {
            toggle._kltOriginalSync();
            this._applyLowOnlyUi();
        };
    }

    _unhookNativeToggle() {
        const toggle = this._getKeyboardToggle();
        if (!this._toggleHooked)
            return;
        this._toggleHooked = false;
        if (!toggle?._kltOriginalSync)
            return;
        toggle._sync = toggle._kltOriginalSync;
        delete toggle._kltOriginalSync;
        try {
            toggle._sync();
        } catch (_e) {
            // Native widget may already be gone.
        }
    }

    _applyLowOnlyUi() {
        const toggle = this._getKeyboardToggle();
        if (!toggle || !this._isLowOnly())
            return;

        if (toggle._sliderItem)
            toggle._sliderItem.visible = false;
        if (toggle._discreteItem)
            toggle._discreteItem.visible = false;
    }

    _isKeyboardBrightnessIcon(icon) {
        if (!icon)
            return false;
        try {
            const str = icon.to_string();
            return str.includes('keyboard-brightness');
        } catch (_e) {
            return `${icon}`.includes('keyboard-brightness');
        }
    }

    _hookOsd() {
        const mgr = Main.osdWindowManager;
        if (!mgr || this._osdHooked)
            return;

        this._osdHooked = true;
        if (mgr.showAll) {
            mgr._kltShowAll = mgr.showAll.bind(mgr);
            mgr.showAll = (icon, label, level, maxLevel) => {
                if (this._isLowOnly() && this._isKeyboardBrightnessIcon(icon))
                    return;
                mgr._kltShowAll(icon, label, level, maxLevel);
            };
        }
        if (mgr.showOne) {
            mgr._kltShowOne = mgr.showOne.bind(mgr);
            mgr.showOne = (monitorIndex, icon, label, level, maxLevel) => {
                if (this._isLowOnly() && this._isKeyboardBrightnessIcon(icon))
                    return;
                mgr._kltShowOne(monitorIndex, icon, label, level, maxLevel);
            };
        }
    }

    _unhookOsd() {
        const mgr = Main.osdWindowManager;
        if (!this._osdHooked || !mgr)
            return;
        this._osdHooked = false;
        if (mgr._kltShowAll) {
            mgr.showAll = mgr._kltShowAll;
            delete mgr._kltShowAll;
        }
        if (mgr._kltShowOne) {
            mgr.showOne = mgr._kltShowOne;
            delete mgr._kltShowOne;
        }
    }

    _showLightOsd(on) {
        try {
            const icon = Gio.Icon.new_for_string(
                on
                    ? 'keyboard-brightness-symbolic'
                    : 'keyboard-brightness-off-symbolic'
            );
            const mgr = Main.osdWindowManager;
            const show = mgr._kltShowAll ?? mgr.showAll.bind(mgr);
            show(icon, null, null, null);
        } catch (e) {
            console.error(`Keyboard Light Timer: OSD failed: ${e.message}`);
        }
    }

    _handleLowOnlyHotkey(brightness) {
        const low = this._getLowLevel();
        const wasOn = this._lastBrightness > 0 || this._dimmedByUs;

        if (this._dimmedByUs && brightness > 0) {
            this._dimmedByUs = false;
            this._setBrightness(low);
            this._savedBrightness = low;
            this._lastBrightness = low;
            this._showLightOsd(true);
            this._schedule();
            return true;
        }

        // Fn stepped past low (1 → 2/3): treat as toggle off.
        if (wasOn && brightness > low + 10) {
            this._setBrightness(0);
            this._dimmedByUs = false;
            this._lastBrightness = 0;
            this._showLightOsd(false);
            this._clearWatches();
            return true;
        }

        // Off → on (Fn first step, or Quick Settings 100%).
        if (!wasOn && brightness > 0) {
            this._setBrightness(low);
            this._savedBrightness = low;
            this._lastBrightness = low;
            this._showLightOsd(true);
            this._schedule();
            return true;
        }

        if (wasOn && brightness === 0) {
            this._showLightOsd(false);
            return false;
        }

        return false;
    }

    _clearWatches() {
        if (!this._idleMonitor)
            return;

        if (this._idleWatchId) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
        if (this._activeWatchId) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }
    }

    _addIdleWatch(timeoutMs, callback) {
        try {
            let flags = Meta.IdleMonitorWatchFlags.UNINHIBITABLE;
            if (Meta.IdleMonitorWatchFlags.START_NOW !== undefined)
                flags |= Meta.IdleMonitorWatchFlags.START_NOW;
            if (this._idleMonitor.add_idle_watch_full && Meta.IdleMonitorWatchFlags) {
                return this._idleMonitor.add_idle_watch_full(
                    timeoutMs,
                    callback,
                    flags
                );
            }
        } catch (e) {
            console.error(`Keyboard Light Timer: uninhibitable watch failed: ${e.message}`);
        }
        return this._idleMonitor.add_idle_watch(timeoutMs, callback);
    }

    _schedule() {
        this._clearWatches();

        if (!this._idleMonitor || !this._proxy || !this._settings)
            return;

        const timeoutSec = this._settings.get_int('timeout-seconds');
        if (timeoutSec <= 0)
            return;

        const brightness = this._proxy.Brightness;
        if (!Number.isInteger(brightness) || brightness < 0)
            return;

        // Light is off by the user — do not wait, do not loop.
        if (brightness <= 0 && !this._dimmedByUs)
            return;

        // Already dimmed: wait for compositor-level input (typing in any app).
        if (this._dimmedByUs) {
            this._watchActivity();
            return;
        }

        this._idleWatchId = this._addIdleWatch(timeoutSec * 1000, () => {
            this._idleWatchId = 0;
            this._dimNow();
        });
    }

    _watchActivity() {
        if (!this._idleMonitor || this._activeWatchId)
            return;

        this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._activeWatchId = 0;
            this._onActive();
        });
    }

    _dimNow() {
        const brightness = this._proxy?.Brightness;
        if (Number.isInteger(brightness) && brightness > 0) {
            this._savedBrightness = brightness;
            this._dimmedByUs = true;
            this._setBrightness(0);
        }

        this._watchActivity();
    }

    _onActive() {
        if (this._dimmedByUs) {
            const restore = this._isLowOnly()
                ? this._getLowLevel()
                : (this._savedBrightness ?? 100);
            this._dimmedByUs = false;
            if (restore > 0)
                this._setBrightness(restore);
        }
        this._schedule();
    }

    _setBrightness(value) {
        if (!this._proxy)
            return;

        const target = Math.round(value);
        if (this._proxy.Brightness === target) {
            this._lastBrightness = target;
            this._echoBrightness = null;
            return;
        }

        this._echoBrightness = target;

        try {
            this._proxy.Brightness = target;
            this._lastBrightness = target;
        } catch (e) {
            this._echoBrightness = null;
            console.error(`Keyboard Light Timer: set brightness failed: ${e.message}`);
        }
    }

    _onBrightnessChanged(brightness) {
        if (!Number.isInteger(brightness) || brightness < 0)
            return;

        if (this._echoBrightness !== null) {
            const echo = this._echoBrightness;
            this._echoBrightness = null;
            if (brightness === echo)
                return;
        }

        if (this._isLowOnly() && this._handleLowOnlyHotkey(brightness)) {
            this._rememberBrightness(this._lastBrightness);
            return;
        }

        if (brightness === this._lastBrightness)
            return;

        this._lastBrightness = brightness;

        if (this._dimmedByUs) {
            if (brightness <= 0)
                return;
            this._rememberBrightness(brightness);

            // User or firmware turned the light back on while we had dimmed it.
            this._dimmedByUs = false;
            this._savedBrightness = this._isLowOnly() ? this._getLowLevel() : brightness;
            this._schedule();
            return;
        }

        this._rememberBrightness(brightness);

        if (brightness > 0) {
            this._savedBrightness = this._isLowOnly() ? this._getLowLevel() : brightness;
            this._schedule();
            return;
        }

        this._clearWatches();
    }
}
