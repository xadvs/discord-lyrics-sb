# spotify-lyrics-discord

Syncs your Discord custom status to the lyrics of the song currently playing
on Spotify, using the official Spotify Web API and the free LRCLIB lyrics
database.

⚠️ **Note on Discord ToS**: this updates your account's custom status using
your personal account token via the REST API, not through Discord's official
bot/RPC system. That's technically "self-botting" automation, which is
against Discord's Terms of Service. Enforcement for light personal use like
this is rare in practice, but the risk (a warning or account action) is real
and entirely yours to take.

## 1. Install dependencies

```bash
npm install
```

Requires **Node.js 18 or newer** (uses the built-in `fetch`).

## 2. Create a Spotify app

1. Go to https://developer.spotify.com/dashboard and log in.
2. Click **Create app**.
3. Set a Redirect URI to `http://127.0.0.1:8888/callback` (you'll use this
   once, just to get a refresh token).
4. Copy the **Client ID** and **Client Secret** into your `.env` file.

## 3. Get a Spotify refresh token (one-time)

Open this URL in your browser (replace `YOUR_CLIENT_ID`):

```
https://accounts.spotify.com/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://127.0.0.1:8888/callback&scope=user-read-currently-playing
```

Log in and approve. You'll be redirected to a URL like
`http://127.0.0.1:8888/callback?code=AQC...` — copy the `code` value, then
run this (replace the placeholders):

```bash
curl -X POST https://accounts.spotify.com/api/token \
  -H "Authorization: Basic $(echo -n 'YOUR_CLIENT_ID:YOUR_CLIENT_SECRET' | base64)" \
  -d grant_type=authorization_code \
  -d code=YOUR_CODE \
  -d redirect_uri=http://127.0.0.1:8888/callback
```

The JSON response contains a `refresh_token` — put that in your `.env`.

## 4. Get your Discord token

Open Discord in your browser, press `Ctrl+Shift+I` to open DevTools, go to
the **Network** tab, refresh, click any request to `discord.com/api`, and
copy the `authorization` header value from the request headers. Put it in
`.env` as `DISCORD_TOKEN`.

**Never share this token with anyone or paste it anywhere public** — it is
equivalent to your password.

## 5. Configure and run

```bash
cp .env.example .env
# edit .env with your values
npm start
```

Your Discord custom status will now follow the currently playing lyric line.
Press `Ctrl+C` to stop — it will restore your previous status automatically.

## How it works

```
Spotify (official API) → currently playing track + progress
         │
         ▼
    LRCLIB API → synced .lrc lyrics for that track
         │
         ▼
  pick the line whose timestamp ≤ current playback position
         │
         ▼
  PATCH discord.com/api/v9/users/@me/settings → custom_status.text
```

## Notes

- If a track has no synced lyrics on LRCLIB, the status falls back to
  `Artist - Title`.
- Status updates are skipped when the text hasn't changed, to reduce API
  calls and avoid rate limits.
- This only reads your *own* Spotify playback (via your Spotify account) —
  it doesn't need Spotify to be linked to Discord.
