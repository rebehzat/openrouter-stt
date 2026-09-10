# OpenRouter Speech-to-Text (GNOME Shell extension)

Hold **F9** to record, release to transcribe — the text is pasted at your cursor.
Transcription runs through [OpenRouter's speech-to-text API](https://openrouter.ai/models?q=transcription),
so you can pick from dozens of models (Whisper, Grok STT, Voxtral, Mai-Transcribe, …)
with a single API key.

## Features

- **Push-to-talk, press-and-hold**: press & hold `F9` → a big full-screen indicator appears;
  release → recording stops and the transcript is auto-pasted at the cursor (`Esc` cancels).
- **Any OpenRouter STT model**: default `openai/whisper-large-v3-turbo`, changeable in the
  settings (presets + custom model ID), e.g. `x-ai/grok-stt-1.0`,
  `mistralai/voxtral-small-24b-2507-stt`, `microsoft/mai-transcribe-2`, …
- **Secure key storage**: your OpenRouter token is written to
  `~/.config/openrouter-stt/token` with `0600` permissions (never stored in GSettings/dconf).
- **Smart pasting**: sets the clipboard, then injects `Ctrl+V`/types via
  `ydotool` (Wayland) or `xdotool` (X11) when available; otherwise falls back to
  clipboard + a "press Ctrl+V" hint.
- **Status feedback**: big pulsing indicator → "Transcribing…" → notification with result.

## Requirements

- GNOME Shell 45 – 50 (Wayland or X11)
- `gstreamer1.0-plugins-good` and `-bad` (for PulseAudio capture + Opus/OGG encoding) —
  usually installed by default
- An [OpenRouter API key](https://openrouter.ai/keys) with a little credit

## Install

```bash
git clone https://github.com/rebehzat/openrouter-stt.git
cd openrouter-stt
./install.sh          # symlinks into ~/.local/share/gnome-shell/extensions and compiles the schema
gnome-extensions enable openrouter-stt@foxxy
```

Then add your API key in **Settings → OpenRouter Speech-to-Text** (or `gnome-extensions
prefs openrouter-stt@foxxy`).

## Usage

| Action | Result |
| --- | --- |
| Press & hold `F9` | Recording starts, indicator appears |
| Release `F9` | Recording stops → transcription → text pasted at cursor |
| Press `Esc` while recording | Cancel |
| Settings | change model, toggle auto-paste, view/rebind shortcut |

**Auto-paste on Wayland:** GNOME/mutter does not implement the virtual-keyboard protocol,
so to type into the focused app automatically, install
[`ydotool`](https://github.com/ReimuNotMoe/ydotool) and add your user to the `input`
group (or run the daemon as root). Without it, the extension copies to the clipboard and
prompts you to paste with `Ctrl+V`.

## Model list (as of Sept 2026)

You can enter any transcription model from
[openrouter.ai/models](https://openrouter.ai/models?q=transcription). Presets include:

`openai/whisper-large-v3-turbo` · `openai/whisper-large-v3` · `openai/whisper-1` ·
`openai/gpt-4o-transcribe` · `openai/gpt-4o-mini-transcribe` · `openai/gpt-transcribe` ·
`x-ai/grok-stt-1.0` · `mistralai/voxtral-small-24b-2507-stt` · `mistralai/voxtral-mini-3b-2507` ·
`microsoft/mai-transcribe-2` · `microsoft/mai-transcribe-1.5` · `deepgram/nova-3` ·
`google/chirp-3` · `nvidia/parakeet-tdt-0.6b-v3` ·
`nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b` · `qwen/qwen3-asr-1.7b` ·
`qwen/qwen3-asr-0.6b` · `fish-audio/transcribe-1`

## Security

- The API key lives in `~/.config/openrouter-stt/token`, mode `0600` (user-only).
- Recording happens locally and is uploaded to the model provider only for transcription.
- No data is ever stored by the extension itself.

## Troubleshooting

- **"No API key set"** → open the extension settings and paste your token.
- **"Recording failed: Could not get an input device"** → no microphone / the default
  PulseAudio source is missing. Check `pactl list sources short`.
- **Not pasting on Wayland** → see *Auto-paste on Wayland* above (needs `ydotool`).
- **Transcription HTTP 4xx/5xx** → check the model ID and that you have credits.

## Development

```bash
# reload the shell code after edits:
gnome-extensions reset openrouter-stt@foxxy   # or restart the session
journalctl --user -b | grep -i openrouter    # logs
```

## License

MIT — see [LICENSE](LICENSE).