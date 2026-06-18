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
- `MUSIC_API_DEFAULT_PLATFORM=netease`
- `MUSIC_API_PLATFORMS=netease`

## Recommended

- `BLOB_READ_WRITE_TOKEN`

Create a Vercel Blob store for the project. Without Blob, generated podcast files are stored in `/tmp` and can disappear when the serverless function instance changes.

- `NETEASE_COOKIE`

Paste a valid NetEase Cloud Music cookie if you want stable playlist access on Vercel. QR/phone login can still work, but serverless file state is temporary.

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
