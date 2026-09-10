// OpenRouter Speech-to-Text — GNOME Shell extension
// Hold F9 to record, release to transcribe via OpenRouter's
// STT API — the text lands at your cursor (clipboard + input injection).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gst from 'gi://Gst';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// NB: this name must EXACTLY match a key in the GSettings schema.
// Mutter's meta_display_add_keybinding() calls g_settings_get_strv(name)
// and GLib aborts the entire shell process if the key is missing.
const KEYBINDING = 'recording-key';
const API_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';
const RECORD_FORMAT = 'ogg';
const MAX_RECORDING_SECONDS = 60;
const EOS_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ */
/* API key storage: ~/.config/openrouter-stt/token, chmod 600         */
/* ------------------------------------------------------------------ */

function tokenPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'openrouter-stt', 'token']);
}

function readToken() {
    const path = tokenPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return null;
    try {
        const [, contents] = GLib.file_get_contents(path);
        const token = String(contents).trim();
        return token || null;
    } catch (e) {
        log(`openrouter-stt: failed to read token: ${e}`);
        return null;
    }
}

/* ------------------------------------------------------------------ */
/* Microphone recording (GStreamer)                                    */
/* ------------------------------------------------------------------ */

class Recorder {
    constructor() {
        this.pipeline = null;
        this.path = null;
        this.onError = null;
        this._busWatch = 0;
        this._eosResolver = null;
        if (!Gst.is_initialized())
            Gst.init(null);
    }

    start(path) {
        this.path = path;
        const desc = [
            'pulsesrc',
            'audioconvert',
            'audioresample',
            'audio/x-raw,format=S16LE,rate=16000,channels=1',
            'opusenc',
            'oggmux',
            `filesink location=${path}`,
        ].join(' ! ');

        this.pipeline = Gst.parse_launch(desc);
        if (!this.pipeline)
            throw new Error('Could not build the GStreamer recording pipeline (missing plugins?).');

        this._bus = this.pipeline.get_bus();
        this._bus.add_signal_watch();
        this._busWatch = this._bus.connect('message', (_bus, msg) => {
            switch (msg.type) {
            case Gst.MessageType.ERROR: {
                const [err] = msg.parse_error();
                log(`openrouter-stt: gstreamer error: ${err.message}`);
                if (this.onError)
                    this.onError(err.message);
                break;
            }
            case Gst.MessageType.EOS:
                if (this._eosResolver) {
                    const resolve = this._eosResolver;
                    this._eosResolver = null;
                    resolve();
                }
                break;
            }
        });

        this.pipeline.set_state(Gst.State.PLAYING);
    }

    waitForEos(timeoutMs = EOS_TIMEOUT_MS) {
        return new Promise(resolve => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                log('openrouter-stt: timed out waiting for recorder EOS');
                this._eosResolver = null;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._eosResolver = () => {
                GLib.source_remove(timer);
                resolve();
            };
        });
    }

    async stop() {
        if (!this.pipeline)
            return null;
        this.pipeline.send_event(Gst.Event.new_eos());
        await this.waitForEos();
        this.teardown();
        return this._readFile();
    }

    cancel() {
        this.teardown();
    }

    teardown() {
        if (this.pipeline) {
            this.pipeline.set_state(Gst.State.NULL);
            if (this._busWatch) {
                this._bus.remove_signal_watch();
                this._bus.disconnect(this._busWatch);
                this._busWatch = 0;
            }
            this.pipeline = null;
        }
    }

    _readFile() {
        const { path } = this;
        this.path = null;
        if (!path)
            return null;
        try {
            const [, contents] = GLib.file_get_contents(path);
            return contents; // Uint8Array
        } catch (e) {
            log(`openrouter-stt: failed to read recording: ${e}`);
            return null;
        } finally {
            try {
                GLib.unlink(path);
            } catch (e) {
                // ignore
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* OpenRouter transcription                                            */
/* ------------------------------------------------------------------ */

async function transcribe(token, model, audioBytes) {
    const body = JSON.stringify({
        model,
        input_audio: {
            data: GLib.base64_encode(audioBytes),
            format: RECORD_FORMAT,
        },
    });

    const session = new Soup.Session();
    const message = Soup.Message.new('POST', API_URL);
    message.get_request_headers().append('Authorization', `Bearer ${token}`);
    message.get_request_headers().append('Content-Type', 'application/json');
    message.set_request_body_from_bytes('application/json',
        new GLib.Bytes(new TextEncoder().encode(body)));

    // send_and_read_async is promisified by gnome-shell at startup and
    // returns the response body; the HTTP status is on message.status_code.
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    const result = new TextDecoder().decode(bytes.get_data());

    if (message.status_code !== 200)
        throw new Error(`OpenRouter returned HTTP ${message.status_code}: ${result.slice(0, 300)}`);

    const json = JSON.parse(result);
    if (typeof json?.text !== 'string')
        throw new Error('Unexpected response from OpenRouter.');
    return json.text.trim();
}

/* ------------------------------------------------------------------ */
/* Pasting: clipboard + best-effort input injection                    */
/* ------------------------------------------------------------------ */

function spawn(argv) {
    try {
        const proc = new Gio.Subprocess({
            argv,
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        proc.init(null);
        return true;
    } catch (e) {
        log(`openrouter-stt: failed to start ${argv[0]}: ${e}`);
        return false;
    }
}

function pasteText(text) {
    const clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    clipboard.set_text(St.ClipboardType.PRIMARY, text);

    const wayland = Meta.is_wayland_compositor();
    let tool = null;

    if (wayland) {
        // ydotool types text directly; wtype needs the (mutter-unsupported)
        // zwp_virtual_keyboard protocol, so it's only a last resort.
        if (GLib.find_program_in_path('ydotool'))
            tool = ['ydotool', ['type', '--key-delay=10', text]];
        else if (GLib.find_program_in_path('wtype'))
            tool = ['wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl']];
    } else if (GLib.find_program_in_path('xdotool')) {
        tool = ['xdotool', ['key', '--clearmodifiers', 'ctrl+v']];
    }

    if (tool && spawn([tool[0], ...tool[1]]))
        return { injected: true, tool: tool[0] };

    return { injected: false, tool: null };
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default class OpenrouterSttExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._recording = false;
        this._modalActive = false;
        this._grab = null;
        this._releaseId = 0;
        this._pressId = 0;
        this._watchdog = 0;
        this._recorder = null;
        this._destroyed = false;

        this._buildOverlay();

        // Safety: never call addKeybinding() with a key that isn't in the
        // schema — mutter aborts gnome-shell on a missing keybinding key.
        if (this._settings.settings_schema?.has_key(KEYBINDING)) {
            Main.wm.addKeybinding(KEYBINDING, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._onRecordKey());
        } else {
            log(`openrouter-stt: schema key '${KEYBINDING}' missing — keybinding not registered`);
        }
    }

    disable() {
        this._destroyed = true;
        if (this._recording)
            this._stopRecording(true);
        if (this._releaseId) {
            this._overlay.disconnect(this._releaseId);
            this._releaseId = 0;
        }
        if (this._pressId) {
            this._overlay.disconnect(this._pressId);
            this._pressId = 0;
        }
        Main.wm.removeKeybinding(KEYBINDING);
        this._destroyOverlay();
        this._settings = null;
    }

    /* ---------------- key handling ---------------- */

    // Press-and-hold: the keybinding fires on press. Release/Escape are
    // detected on the OVERLAY ACTOR — mutter's grab (pushModal) sets stage
    // key-focus to it, so key events are delivered there, NOT to the stage.
    // Listening on global.stage was why the release was never seen.
    // A 60s watchdog bounds any missed release so the screen can never
    // stay blocked longer than a minute.
    _onRecordKey() {
        if (this._recording)
            return;

        const path = GLib.build_filenamev([GLib.get_tmp_dir(), `openrouter-stt-${Date.now()}.ogg`]);
        this._recorder = new Recorder();
        this._recorder.onError = msg => {
            this._stopRecording(true);
            Main.notify('OpenRouter STT', `Recording failed: ${msg}`);
        };
        try {
            this._recorder.start(path);
        } catch (e) {
            this._recorder = null;
            Main.notify('OpenRouter STT', `Could not start recording: ${e.message}`);
            return;
        }

        this._recording = true;
        this._showRecordingUI();

        this._grab = Main.pushModal(this._overlay, {
            actionMode: Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
        });
        this._modalActive = true;

        this._releaseId = this._overlay.connect('key-release-event',
            (_actor, event) => this._onKeyRelease(event));
        this._pressId = this._overlay.connect('key-press-event',
            (_actor, event) => this._onKeyPress(event));

        this._watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAX_RECORDING_SECONDS, () => {
            log('openrouter-stt: max recording time reached, finishing');
            this._stopRecording(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onKeyRelease(event) {
        if (event.get_keyval() === Clutter.KEY_F9)
            this._stopRecording(false);
    }

    _onKeyPress(event) {
        if (event.get_keyval() === Clutter.KEY_Escape)
            this._stopRecording(true);
    }

    /* ---------------- recording lifecycle ---------------- */

    async _stopRecording(cancelled = false) {
        if (!this._recording)
            return;
        this._recording = false;

        if (this._releaseId) {
            this._overlay.disconnect(this._releaseId);
            this._releaseId = 0;
        }
        if (this._pressId) {
            this._overlay.disconnect(this._pressId);
            this._pressId = 0;
        }
        if (this._watchdog) {
            GLib.source_remove(this._watchdog);
            this._watchdog = 0;
        }
        this._popModal();

        const recorder = this._recorder;
        this._recorder = null;
        if (!recorder)
            return;

        if (cancelled) {
            recorder.cancel();
            this._hideUI();
            return;
        }

        this._showTranscribingUI();
        try {
            const bytes = await recorder.stop();
            if (this._destroyed)
                return;
            if (!bytes || bytes.byteLength < 200) {
                this._hideUI();
                Main.notify('OpenRouter STT', 'No usable audio captured — is your microphone working?');
                return;
            }

            const token = readToken();
            if (!token) {
                this._hideUI();
                Main.notify('OpenRouter STT',
                    'No API key set — open the extension settings and add your OpenRouter token.');
                return;
            }

            const model = this._settings.get_string('model');
            const text = await transcribe(token, model, bytes);
            this._hideUI();

            if (!text) {
                Main.notify('OpenRouter STT', 'No speech detected in the recording.');
                return;
            }
            this._complete(text);
        } catch (e) {
            log(`openrouter-stt: ${e}`);
            this._hideUI();
            Main.notify('OpenRouter STT', `Transcription failed: ${e.message || e}`);
        }
    }

    _complete(text) {
        const preview = text.length > 140 ? `${text.slice(0, 137)}…` : text;
        if (!this._settings.get_boolean('auto-paste')) {
            Main.notify('OpenRouter STT', `“${preview}”`);
            return;
        }
        const { injected, tool } = pasteText(text);
        const state = injected
            ? `Pasted at cursor (via ${tool}).`
            : 'Copied to clipboard — press Ctrl+V to paste.';
        Main.notify('OpenRouter STT', `“${preview}”\n${state}`);
    }

    /* ---------------- overlay UI ---------------- */

    _buildOverlay() {
        this._overlay = new St.Widget({
            style_class: 'stt-overlay',
            visible: false,
            reactive: true,
        });
        this._overlay.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'stt-box',
        });

        this._icon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            icon_size: 128,
            style_class: 'stt-icon',
        });
        this._label = new St.Label({ text: 'Recording…', style_class: 'stt-label' });
        this._modelLabel = new St.Label({ text: '', style_class: 'stt-model' });
        this._hint = new St.Label({ text: '', style_class: 'stt-hint' });

        box.add_child(this._icon);
        box.add_child(this._label);
        box.add_child(this._modelLabel);
        box.add_child(this._hint);
        this._overlay.add_child(box);

        Main.uiGroup.add_child(this._overlay);
    }

    _popModal() {
        if (this._modalActive && this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (e) {
                log(`openrouter-stt: popModal failed: ${e}`);
            }
            this._grab = null;
            this._modalActive = false;
        }
    }

    _destroyOverlay() {
        if (this._overlay) {
            this._popModal();
            Main.uiGroup.remove_child(this._overlay);
            this._overlay.destroy();
            this._overlay = null;
        }
    }

    _showRecordingUI() {
        this._icon.icon_name = 'audio-input-microphone-symbolic';
        this._icon.style_class = 'stt-icon';
        this._label.text = 'Recording…';
        this._modelLabel.text = this._settings.get_string('model');
        this._hint.text = 'Release F9 to transcribe · Esc to cancel';
        this._overlay.style_class = 'stt-overlay';
        this._overlay.show();
        this._startPulse();
    }

    _showTranscribingUI() {
        this._icon.icon_name = 'content-loading-symbolic';
        this._icon.style_class = 'stt-icon transcribing';
        this._label.text = 'Transcribing…';
        this._hint.text = '';
        this._overlay.style_class = 'stt-overlay transcribing';
    }

    _hideUI() {
        this._stopPulse();
        this._overlay.hide();
    }

    _startPulse() {
        this._stopPulse();
        this._icon.pivot_point = new Clutter.Point({ x: 0.5, y: 0.5 });
        for (const property of ['scale-x', 'scale-y']) {
            const transition = new Clutter.PropertyTransition({
                property,
                from: 1.0,
                to: 1.18,
                duration: 650,
                progress_mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                auto_reverse: true,
                repeat_count: -1,
            });
            this._icon.add_transition(`pulse-${property}`, transition);
        }
    }

    _stopPulse() {
        for (const property of ['scale-x', 'scale-y'])
            this._icon.remove_transition(`pulse-${property}`);
        this._icon.scale_x = 1.0;
        this._icon.scale_y = 1.0;
    }
}