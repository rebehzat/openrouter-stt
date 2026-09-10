// Preferences for the OpenRouter Speech-to-Text extension.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CUSTOM_MODEL = '…custom model…';

const PRESET_MODELS = [
    'openai/whisper-large-v3-turbo',
    'openai/whisper-large-v3',
    'openai/whisper-1',
    'openai/gpt-4o-transcribe',
    'openai/gpt-4o-mini-transcribe',
    'openai/gpt-transcribe',
    'x-ai/grok-stt-1.0',
    'mistralai/voxtral-small-24b-2507-stt',
    'mistralai/voxtral-mini-3b-2507',
    'microsoft/mai-transcribe-2',
    'microsoft/mai-transcribe-1.5',
    'deepgram/nova-3',
    'google/chirp-3',
    'nvidia/parakeet-tdt-0.6b-v3',
    'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b',
    'qwen/qwen3-asr-1.7b',
    'qwen/qwen3-asr-0.6b',
    'fish-audio/transcribe-1',
];

function tokenPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'openrouter-stt', 'token']);
}

function writeToken(value) {
    try {
        const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'openrouter-stt']);
        GLib.mkdir_with_parents(dir, 0o755);
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'token']));
        file.replace_contents(new TextEncoder().encode(`${value}\n`), null, false,
            Gio.FileCreateFlags.PRIVATE, null);
    } catch (e) {
        log(`openrouter-stt: failed to store API key: ${e}`);
    }
}

function clearToken() {
    const path = tokenPath();
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        try {
            GLib.unlink(path);
        } catch (e) {
            // ignore
        }
    }
}

export default class OpenrouterSttPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();

        /* ---------------- API key ---------------- */
        const apiGroup = new Adw.PreferencesGroup({ title: 'OpenRouter API key' });
        const tokenRow = new Adw.ActionRow({
            title: 'API key',
            subtitle: 'Create one at https://openrouter.ai/keys',
        });
        const tokenEntry = new Gtk.PasswordEntry({ show_peek_icon: true });
        tokenEntry.set_text(this._readToken() ?? '');
        tokenRow.add_suffix(tokenEntry);
        tokenRow.set_activatable_widget(tokenEntry);

        let saveId = 0;
        const scheduleSave = () => {
            if (saveId)
                GLib.source_remove(saveId);
            saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                saveId = 0;
                const value = tokenEntry.get_text().trim();
                if (value)
                    writeToken(value);
                else
                    clearToken();
                return GLib.SOURCE_REMOVE;
            });
        };
        tokenEntry.connect('notify::text', scheduleSave);

        const storageHint = new Gtk.Label({
            label: 'Stored in ~/.config/openrouter-stt/token with 0600 permissions (never in GSettings).',
            xalign: 0,
            wrap: true,
        });
        storageHint.add_css_class('dim-label');

        apiGroup.add(tokenRow);
        apiGroup.add(storageHint);
        const apiPage = new Adw.PreferencesPage({
            title: 'API Key',
            icon_name: 'dialog-password-symbolic',
        });
        apiPage.add(apiGroup);
        window.add(apiPage);

        /* ---------------- model ---------------- */
        const modelGroup = new Adw.PreferencesGroup({ title: 'Model' });
        const modelRow = new Adw.ActionRow({
            title: 'Transcription model',
            subtitle: 'Model ID for the /audio/transcriptions endpoint',
        });
        const combo = new Gtk.ComboBoxText();
        for (const model of PRESET_MODELS)
            combo.append_text(model);
        combo.append_text(CUSTOM_MODEL);

        modelRow.add_suffix(combo);
        modelRow.set_activatable_widget(combo);
        modelGroup.add(modelRow);

        const customRow = new Adw.ActionRow({ title: 'Custom model ID' });
        const customEntry = new Gtk.Entry({ placeholder_text: 'vendor/model-name' });
        customRow.add_suffix(customEntry);
        customRow.set_activatable_widget(customEntry);
        modelGroup.add(customRow);

        const current = this._settings.get_string('model');
        const presetIndex = PRESET_MODELS.indexOf(current);
        if (presetIndex >= 0) {
            combo.set_active(presetIndex);
            customRow.set_visible(false);
        } else {
            combo.set_active(PRESET_MODELS.length);
            customEntry.set_text(current);
            customRow.set_visible(true);
        }

        const applyModel = () => {
            const active = combo.get_active();
            if (active >= 0 && active < PRESET_MODELS.length) {
                customRow.set_visible(false);
                this._settings.set_string('model', PRESET_MODELS[active]);
            } else {
                customRow.set_visible(true);
            }
        };
        combo.connect('changed', applyModel);
        customEntry.connect('notify::text', () => {
            if (combo.get_active() === PRESET_MODELS.length) {
                const custom = customEntry.get_text().trim();
                if (custom)
                    this._settings.set_string('model', custom);
            }
        });

        const modelPage = new Adw.PreferencesPage({
            title: 'Model',
            icon_name: 'system-run-symbolic',
        });
        modelPage.add(modelGroup);
        window.add(modelPage);

        /* ---------------- output ---------------- */
        const outputGroup = new Adw.PreferencesGroup({ title: 'Output' });
        const pasteRow = new Adw.ActionRow({
            title: 'Paste at cursor',
            subtitle: 'Paste the transcript after transcribing. Falls back to the clipboard '
                + 'when no input-injection tool (ydotool/xdotool) is available.',
        });
        const pasteSwitch = new Gtk.Switch({
            active: this._settings.get_boolean('auto-paste'),
            valign: Gtk.Align.CENTER,
        });
        pasteRow.add_suffix(pasteSwitch);
        pasteRow.set_activatable_widget(pasteSwitch);
        pasteSwitch.connect('notify::active', () => {
            this._settings.set_boolean('auto-paste', pasteSwitch.get_active());
        });
        outputGroup.add(pasteRow);
        const outputPage = new Adw.PreferencesPage({
            title: 'Output',
            icon_name: 'edit-paste-symbolic',
        });
        outputPage.add(outputGroup);
        window.add(outputPage);

        /* ---------------- shortcut ---------------- */
        const shortcutGroup = new Adw.PreferencesGroup({ title: 'Shortcut' });
        const shortcutRow = new Adw.ActionRow({
            title: 'Recording shortcut',
            subtitle: 'Press to start recording, press again to transcribe.',
        });
        const keys = this._settings.get_strv('recording-key');
        const keyLabel = new Gtk.Label({ label: keys.join(', ') });
        shortcutRow.add_suffix(keyLabel);
        shortcutGroup.add(shortcutRow);

        const settingsRow = new Adw.ActionRow({
            title: 'Rebind shortcut',
            subtitle: 'Extension shortcuts can be changed in Settings → Keyboard → '
                + 'Customize Shortcuts → Extensions.',
        });
        const settingsButton = new Gtk.Button({ label: 'Open Settings…' });
        settingsButton.connect('clicked', () => {
            try {
                GLib.spawn_command_line_async('gnome-control-center keyboard');
            } catch (e) {
                log(`openrouter-stt: ${e}`);
            }
        });
        settingsRow.add_suffix(settingsButton);
        settingsRow.set_activatable_widget(settingsButton);
        shortcutGroup.add(settingsRow);

        const shortcutPage = new Adw.PreferencesPage({
            title: 'Shortcut',
            icon_name: 'input-keyboard-symbolic',
        });
        shortcutPage.add(shortcutGroup);
        window.add(shortcutPage);
    }

    _readToken() {
        const path = tokenPath();
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return null;
        try {
            const [, contents] = GLib.file_get_contents(path);
            const token = String(contents).trim();
            return token || null;
        } catch (e) {
            log(`openrouter-stt: failed to read API key from ${path}: ${e}`);
            return null;
        }
    }
}