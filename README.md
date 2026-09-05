# ZCamGuiOpen — ZCamera Client

A local desktop client for **ZCamera cameras**, built with Electron + TypeScript.
It discovers cameras on the LAN, signs in with the camera's native authentication, shows a
live preview, and exposes the camera's settings — including PTZ models.

This is an independent community tool, not affiliated with or endorsed by Z CAM.

## Features

- **Discovery** — mDNS (`_eagle._tcp`, the legacy camera service label retained for compatibility) scanned per network interface, plus manual entry by IP
- **Authentication** — HTTP Digest login against the camera's `/login/` endpoint, with a
  browser-equivalent fallback through the camera's own login page for firmwares that only
  accept the page flow
- **Protocol negotiation** — HTTP:80 → HTTPS:443 → HTTPS:80 auto-negotiation with
  `https_on` handling and a per-camera HTTP/HTTPS override
- **Live preview** — WebRTC (embedded webrtc-streamer) with automatic MJPEG fallback,
  streamed through the main process so authentication and self-signed TLS just work
- **Live HUD** — shutter / ISO / EV / white balance / iris / FPS / resolution / temperature,
  kept current by the camera's WebSocket notifications
- **Recording & photo** — start/stop recording, photo capture, card-present and
  remaining-space gating, duration/remaining/file overlays
- **Settings** — grouped rows mirroring the camera's own menu (exposure, white balance,
  focus, image, record, video, stream, audio, system, PTZ, …) with dependency re-reads and
  WebSocket-driven refresh; unsupported rows hide automatically
- **Streaming** — stream bitrate, RTMP push (SRT/NDI endpoints known, UI not implemented)
- **AF area overlay** — click-to-focus / draggable focus zone on the preview
- **Debug panel** — every protocol exchange can be inspected (never logs credentials)

## Requirements

- Node.js 18+ and npm
- A Z CAM camera reachable on the local network with its web API enabled
- Windows / macOS / Linux (developed on Windows)

## Build & run

```bash
npm install
npm run build   # compiles main + renderer and assembles dist/
npm start       # build + launch Electron
npm run typecheck
```

## Project structure

| Path | Purpose |
|------|---------|
| `src/main.ts` | Electron main process: window, IPC surface, certificate handling, MJPEG/WebRTC proxies |
| `src/camera/` | Camera communication: HTTP transport (Digest auth, origin negotiation), WebSocket notifications, per-camera state store, settings engine, stream control, browser login fallback |
| `src/main/` | Orchestration: camera manager (multi-camera sessions), mDNS discovery, per-host TLS trust |
| `src/renderer/` | UI (no framework): discovery, live view, settings |
| `src/shared/` | Settings schema shared by main and renderer |
| `scripts/copy-static.cjs` | Assembles the classic-script renderer bundle at build time |
| `scripts/check-publish-boundary.cjs` | Fails if any tracked file is outside the public publish boundary |
| `githooks/` | Committed pre-commit hook enforcing the publish boundary |

## Publishing

This repository is public. The publish boundary is **only `src/`, build metadata, `LICENSE`,
and `README.md`** — everything else (`js/`, `doc/`, generated `dist/`, and probe/AI artifacts)
is git-ignored and must never be committed. Two layers enforce this:

- `.gitignore` keeps the excluded material out of `git status`.
- A pre-commit hook (installed automatically by `npm install` / `npm run prepare` via
  `scripts/install-git-hooks.cjs`) fails any commit that would track such a file, even a
  force-added one. Run the check manually with `npm run check:publish`.

## Security notes

- The camera's self-signed TLS certificate is trusted **per host, only after you connect to
  it** (`src/main/trusted-hosts.ts`) — never globally.
- Credentials are kept in memory for the session only; they are never written to disk or logs.
- All camera traffic to one camera is strictly serialized (the camera's embedded HTTP server
  drops concurrent requests).

## License

[MIT](LICENSE)
