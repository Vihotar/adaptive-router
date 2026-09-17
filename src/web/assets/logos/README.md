# Office View provider logo assets

Drop an **official** provider logo file in this folder and the matching
Office View seat picks it up automatically on the next page load. No code
change is needed.

AR does not download, redraw, trace, recolor or otherwise modify these
assets. It renders whatever file is here as-is, letterboxed inside the seat
node so the original proportions are preserved. Until a file exists for a
seat, that seat shows a neutral fallback node (provider name, short
initials and a simple generic icon).

## Filenames

Name the file after the seat id, with any of these extensions:
`.svg`, `.png`, `.webp`.

| Seat id        | Provider shown       | Example filename      |
| -------------- | -------------------- | --------------------- |
| `claude-code`  | Claude / Anthropic   | `claude-code.svg`     |
| `codex`        | Codex / OpenAI       | `codex.svg`           |
| `antigravity`  | Antigravity / Google | `antigravity.svg`     |
| `gemini`       | Gemini / Google      | `gemini.svg`          |
| `nvidia-nim`   | NVIDIA NIM           | `nvidia-nim.svg`      |
| `openrouter`   | OpenRouter           | `openrouter.svg`      |
| `grok`         | Grok / xAI           | `grok.svg`            |

`.svg` is preferred — it stays sharp at any seat size.

## Where to get them

Take the file from the provider's own brand or press resources, and follow
that provider's brand guidelines for how their mark may be displayed. Only
add a logo you are permitted to use.
