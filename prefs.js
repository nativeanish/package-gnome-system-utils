/* System Monitor Pro — Preferences (GNOME Shell 50) */

import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SystemMonitorProPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(460, 680);

        /* ============== Page: General ============== */

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        /* ---------- Group: Visible Chips ---------- */

        const visGroup = new Adw.PreferencesGroup({
            title: _('Visible Chips'),
            description: _('Choose which monitor chips appear in the top bar. Each chip opens its own dropdown.'),
        });
        page.add(visGroup);

        const chips = [
            ['show-cpu',  'CPU',      'Processor usage, frequency, and temperature'],
            ['show-ram',  'Memory',   'RAM usage, swap, and top consumers'],
            ['show-gpu',  'GPU',      'Graphics utilisation, VRAM, and temperature'],
            ['show-disk', 'Storage',  'Disk usage, I/O throughput, and temperature'],
            ['show-sys',  'Thermals', 'All detected hardware temperature sensors'],
            ['show-net',  'Network',  'Live upload/download throughput per interface'],
        ];

        for (const [key, title, subtitle] of chips) {
            const row = new Adw.SwitchRow({
                title: _(title),
                subtitle: _(subtitle),
            });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            visGroup.add(row);
        }

        /* ---------- Group: Appearance ---------- */

        const appGroup = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Customize the look and feel'),
        });
        page.add(appGroup);

        /* Icons toggle */
        const iconsRow = new Adw.SwitchRow({
            title: _('Use Icons'),
            subtitle: _('Show symbolic icons instead of text labels (CPU, RAM, etc.)'),
        });
        settings.bind('use-icons', iconsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(iconsRow);

        /* Blur sigma */
        const blurRow = new Adw.SpinRow({
            title: _('Glass Blur Strength'),
            subtitle: _('Blur radius for the frosted glass effect (0 = off, 60 = max)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 60,
                step_increment: 5,
                page_increment: 10,
                value: settings.get_int('blur-sigma'),
            }),
        });
        settings.bind('blur-sigma', blurRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(blurRow);

        /* Panel opacity */
        const opacityRow = new Adw.SpinRow({
            title: _('Dropdown Opacity'),
            subtitle: _('Background opacity of dropdown panels (10 = very transparent, 100 = solid)'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
                value: settings.get_int('panel-opacity'),
            }),
        });
        settings.bind('panel-opacity', opacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(opacityRow);

        /* Update interval */
        const intervalRow = new Adw.SpinRow({
            title: _('Update Interval'),
            subtitle: _('Panel refresh rate in milliseconds (500–10000)'),
            adjustment: new Gtk.Adjustment({
                lower: 500,
                upper: 10000,
                step_increment: 100,
                page_increment: 500,
                value: settings.get_int('update-interval'),
            }),
        });
        settings.bind('update-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        appGroup.add(intervalRow);

        /* Panel position */
        const posRow = new Adw.ComboRow({
            title: _('Panel Position'),
            subtitle: _('Which side of the top bar to place the chips'),
            model: Gtk.StringList.new(['Right', 'Center', 'Left']),
        });
        const posMap = {'right': 0, 'center': 1, 'left': 2};
        const posKeys = ['right', 'center', 'left'];
        posRow.set_selected(posMap[settings.get_string('panel-position')] ?? 0);
        posRow.connect('notify::selected', () => {
            settings.set_string('panel-position', posKeys[posRow.get_selected()] || 'right');
        });
        settings.connect('changed::panel-position', () => {
            posRow.set_selected(posMap[settings.get_string('panel-position')] ?? 0);
        });
        appGroup.add(posRow);
    }
}
