---
name: play-music
description: Play music, songs, a playlist or a mood (chill, rest, soul, somali, punjab...) in the user's browser on YouTube Music or regular YouTube. Load this before any "play music" request.
created: 2026-10-09
status: verified
---

# Play music in the browser

Two different sites, two different libraries. Do not mix them up.

| | YouTube Music (music.youtube.com) | Regular YouTube (www.youtube.com) |
|---|---|---|
| Liked songs | Liked Music -- `list=LM` | (no such thing) |
| `list=LL` | -- | Liked VIDEOS: every video ever liked (clips, tutorials, anything). NOT music. |
| User playlists | https://music.youtube.com/library/playlists | https://www.youtube.com/feed/playlists |
| Open a playlist | https://music.youtube.com/playlist?list=<ID> | https://www.youtube.com/playlist?list=<ID> |

Default to YouTube Music for "play music" unless the user names regular YouTube.

## Pick what to play
1. User named a playlist or mood -> use the playlist whose name matches it.
2. Nothing named -> Liked Music (YouTube Music) -- it is their own taste.
3. Not sure which matches the mood -> read the playlists page and pick by name; say which one you chose.

## YouTube Music
1. `browser_navigate` to https://music.youtube.com/library/playlists (or straight to
   https://music.youtube.com/playlist?list=LM for Liked Music).
2. `browser_read_text` to see the playlist names; navigate to the one you picked
   (click its title, or build the playlist URL from its ID).
3. `browser_click` the playlist's Play button ONCE (text "Play").
4. Done. Tell the user it is queued in the Athena tab and starts as soon as they switch to it.

## Regular YouTube
`list=LL` (Liked videos) is not a music playlist. Never use it for music.
1. `browser_navigate` to https://www.youtube.com/feed/playlists.
2. `browser_read_text`; find the user's music playlist by name ("music", "songs", or the
   mood they asked for). If there is none, say so and offer YouTube Music instead.
3. Open it: https://www.youtube.com/playlist?list=<ID> (click the playlist title if you do not have the ID).
4. `browser_click` "Play all" ONCE. That opens watch?v=<VIDEO_ID>&list=<ID> on its own.
5. NEVER hand-build a watch URL without a real video ID. `watch?v=&list=...` (empty v=) shows
   "YouTube is not currently available on this device".

## Autoplay -- do not fight it
Athena's working tab opens in the BACKGROUND on purpose (never steals the user's focus).
Chrome holds audio in a background tab until the user looks at it. That is expected, not a failure.
- Click play ONE time, then stop. Do not retry with other selectors, the first track link,
  `#play-button`, etc. Retrying gains nothing and can restart or change the queue.
- Do not judge success by the tab title -- in a background tab it may stay on the playlist
  name until the user switches over.
- Report: "Queued <playlist> in the Athena tab -- switch to it and it will start."
- After the user has viewed the tab once, pause / next / previous clicks work normally.
