/**
 * spotify-lyrics-discord
 */

const fetchFn = globalThis.fetch; 


const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
  DISCORD_TOKEN,
  POLL_INTERVAL_MS = '4000',
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REFRESH_TOKEN || !DISCORD_TOKEN) {
  console.error(
    'Missing required environment variables. Copy .env.example to .env and fill it in.\n' +
    'Required: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN, DISCORD_TOKEN'
  );
  process.exit(1);
}

const POLL_MS = parseInt(POLL_INTERVAL_MS, 10);


let spotifyAccessToken = null;
let spotifyTokenExpiresAt = 0;
let cachedLyrics = null;       
let cachedTrackKey = null;     
let lastSentStatusText = null; 
let originalStatus = undefined; 


async function getSpotifyAccessToken() {
  if (spotifyAccessToken && Date.now() < spotifyTokenExpiresAt - 5000) {
    return spotifyAccessToken;
  }

  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetchFn('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: SPOTIFY_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  spotifyAccessToken = data.access_token;
  spotifyTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return spotifyAccessToken;
}


async function getCurrentlyPlaying() {
  const token = await getSpotifyAccessToken();
  const res = await fetchFn('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 204) return null; 
  if (!res.ok) {
    console.error(`Spotify currently-playing error: ${res.status}`);
    return null;
  }

  const data = await res.json();
  if (!data || !data.item || !data.is_playing) return null;

  return {
    title: data.item.name,
    artist: data.item.artists.map((a) => a.name).join(', '),
    durationMs: data.item.duration_ms,
    progressMs: data.progress_ms,
  };
}


async function fetchLyrics(track) {
  const params = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
    duration: Math.round(track.durationMs / 1000).toString(),
  });

  const res = await fetchFn(`https://lrclib.net/api/get?${params.toString()}`);
  if (res.status === 404) {
    console.log(`[Lyrics] Not found on LRCLIB: "${track.title}" by ${track.artist}`);
    return null;
  }
  if (!res.ok) {
    console.error(`[Lyrics] LRCLIB error: ${res.status}`);
    return null;
  }

  const data = await res.json();
  if (!data.syncedLyrics) {
    console.log(`[Lyrics] No synced lyrics for "${track.title}", falling back to song name`);
    return null;
  }

  return { synced: parseLrc(data.syncedLyrics) };
}


function parseLrc(lrcText) {
  const lines = [];
  const re = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]\s*(.*)/;

  for (const raw of lrcText.split('\n')) {
    const m = raw.match(re);
    if (!m) continue;
    const [, mm, ss, ms = '0', text] = m;
    const timeMs = (parseInt(mm, 10) * 60 + parseInt(ss, 10)) * 1000 + parseInt(ms.padEnd(3, '0'), 10);
    if (text.trim().length > 0) lines.push({ time: timeMs, text: text.trim() });
  }

  return lines.sort((a, b) => a.time - b.time);
}


function getCurrentLine(synced, progressMs) {
  let current = null;
  for (const line of synced) {
    if (line.time <= progressMs) current = line;
    else break;
  }
  return current;
}


async function setDiscordStatus(text) {
  if (text === lastSentStatusText) return; 
  lastSentStatusText = text;

  const res = await fetchFn('https://discord.com/api/v9/users/@me/settings', {
    method: 'PATCH',
    headers: {
      Authorization: DISCORD_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      custom_status: text ? { text: text.slice(0, 128), emoji_name: '🎵' } : null,
    }),
  });

  if (res.status === 429) {
    const { retry_after } = await res.json();
    console.warn(`[Discord] Rate limited, retrying after ${retry_after}s`);
    await new Promise((r) => setTimeout(r, retry_after * 1000));
    return setDiscordStatus(text);
  }

  if (!res.ok) {
    console.error(`[Discord] Failed to update status: ${res.status} ${await res.text()}`);
  }
}

async function getDiscordCurrentStatus() {
  const res = await fetchFn('https://discord.com/api/v9/users/@me/settings', {
    headers: { Authorization: DISCORD_TOKEN },
  });
  if (!res.ok) return undefined;
  const data = await res.json();
  return data.custom_status ?? null;
}


async function tick() {
  try {
    const track = await getCurrentlyPlaying();

    if (!track) {
      await setDiscordStatus(null); 
      cachedTrackKey = null;
      cachedLyrics = null;
      return;
    }

    const trackKey = `${track.artist} - ${track.title}`;

    if (trackKey !== cachedTrackKey) {
      cachedTrackKey = trackKey;
      cachedLyrics = await fetchLyrics(track);
      if (cachedLyrics) {
        console.log(`[Lyrics] Loaded ${cachedLyrics.synced.length} synced lines for "${trackKey}"`);
      }
    }

    if (cachedLyrics && cachedLyrics.synced.length > 0) {
      const line = getCurrentLine(cachedLyrics.synced, track.progressMs);
      await setDiscordStatus(line ? line.text : trackKey);
    } else {
      
      await setDiscordStatus(trackKey);
    }
  } catch (err) {
    console.error('[Loop] Error:', err.message);
  }
}

async function main() {
  console.log('Starting spotify-lyrics-discord...');
  originalStatus = await getDiscordCurrentStatus();

  const interval = setInterval(tick, POLL_MS);
  tick(); 


  const shutdown = async () => {
    clearInterval(interval);
    console.log('\nRestoring previous Discord status...');
    try {
      const res = await fetchFn('https://discord.com/api/v9/users/@me/settings', {
        method: 'PATCH',
        headers: { Authorization: DISCORD_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_status: originalStatus ?? null }),
      });
      if (!res.ok) console.error('Failed to restore status:', res.status);
    } catch (e) {
      console.error('Failed to restore status:', e.message);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
