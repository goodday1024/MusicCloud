# Vercel Deployment

## Required Environment Variables

Set these in Vercel Project Settings:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_TTS_API_KEY`
- `OPENAI_TTS_BASE_URL`
- `OPENAI_TTS_PATH`
- `OPENAI_TTS_RESPONSE_FORMAT`
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`
- `MUSIC_API_BASE_URL`
- `WP_MUSIC_API_BASE_URL`
- `QQMUSIC_API1_BASE_URL`
- `NETEASE_API_BASE_URL`
- `MUSIC_API_DEFAULT_PLATFORM=netease`
- `MUSIC_API_PLATFORMS=netease`

`QQMUSIC_API1_BASE_URL` points to a running [goodday1024/QQMusicApi1](https://github.com/goodday1024/QQMusicApi1) Web service, for example `http://49.51.189.172:8000` or your own `http://localhost:8080`. CaelumShao prefers this service for QQ scan login, QQ playlists, favorite songs, search, and QQ song URLs.

`WP_MUSIC_API_BASE_URL` points to a running [GitHub-ZC/wp_MusicApi](https://github.com/GitHub-ZC/wp_MusicApi) service, for example `http://localhost:5000` locally or your deployed service URL. CaelumShao uses wp_MusicApi as a fallback for QQ search/play URLs, then falls back to the older PHP music API and SDK paths.

`QQMUSIC_CHARLES_MUSICDL_FALLBACK=true` enables the QQ playback strategy inspired by [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl): first try QQ's official `musicu.fcg` Vkey/EVkey flow with the current QQ Music login credential, then try selected third-party resolvers. The upstream project is PolyForm Noncommercial licensed, so CaelumShao does not vendor or copy that package; it only implements compatible request strategies in this codebase. You can choose resolver order with `QQMUSIC_CHARLES_MUSICDL_APIS=nki,tang,xunhuisi,lpz,lxmusic,vkeys`.

Optional third-party resolver keys:

- `QQMUSIC_NKI_API_KEYS`
- `QQMUSIC_XIANYUW_API_KEYS`
- `QQMUSIC_CY_API_KEYS`
- `QQMUSIC_LXMUSIC_REQUEST_KEY=share-v3`

Leave these empty unless you own valid keys. Resolvers without keys are skipped automatically.

## Recommended

- `BLOB_READ_WRITE_TOKEN`

Create a Vercel Blob store for the project. Without Blob, generated podcast files are stored in `/tmp` and can disappear when the serverless function instance changes.

- `NETEASE_COOKIE`

Paste a valid NetEase Cloud Music cookie if you want stable playlist access on Vercel. QR/phone login can still work, but serverless file state is temporary.

- `QQMUSIC_COOKIE`

Paste a valid QQ Music web cookie from `https://y.qq.com` if you want stable QQ Music playlist access on Vercel. The app also includes an experimental QQ scan login, but Tencent may not always return `qm_keyst` / `qqmusic_key` through that flow, so cookie import is still the reliable fallback.

- `QQMUSIC_QR_APPID`
- `QQMUSIC_QR_CALLBACK`

Optional overrides for the experimental QQ scan login. Defaults are suitable for trying the QQ Music web login flow.

For QR login, set:

```text
NETEASE_API_BASE_URL=https://api-enhanced-ten-dusky.vercel.app
```

Agentio will then use the same `/login/qr/key`, `/login/qr/create?platform=web&ua=pc`, and `/login/qr/check?ua=pc` flow as the working test page, which is less likely to trigger NetEase's device-risk prompt than the raw SDK fallback.

## Not Supported On Vercel

- `HOMEPOD_SHORTCUT_NAME`

HomePod playback uses the macOS `shortcuts` command and only works on a local Mac backend, not on Vercel.

## Deploy

```bash
npm install
npm run build
vercel
```

The Vercel config routes:

- `/` to the Vite static app in `dist`
- `/api/*` to the Express serverless function
- `/media/*` to the same function for local temporary media fallback
