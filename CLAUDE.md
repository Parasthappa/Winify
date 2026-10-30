# Winify: rules for every session

Winify is a Winamp-style Spotify player (Electron + Webamp + the Spotify Web
Playback SDK). User-facing docs: README.md. How it is built: DEVELOPMENT.md.
Where the 1.0 release stands, and what each stage needs: RELEASE_PLAN.md.

## Testing

- Do NOT run the full suite (`npm test`) or the smoke test (`npm run smoke`)
  unless the user explicitly asks.
- After a change, test ONLY the feature you touched, once: its suite by name,
  e.g. `npm test -- picker`.
- Do not launch the app or take screenshots to verify. The user tests it and
  says what's wrong.
- If something fails twice, stop and tell the user. Don't keep retrying.
- Test against the mocks first (`test/mock`, `test/app`). They fake Spotify
  and send it nothing.
- Real Spotify requests count toward the user's rate limit (a 429 can block
  playback for hours). Keep them to the minimum that answers the question:
  one request, never loops or repeated timing samples. Before running anything
  that talks to the real Spotify, state how many requests it will send.
- Never refresh the stored Spotify token outside Winify: Spotify replaces the
  refresh token on every use, which can sign the running Winify out.

## Working style

- Before coding, say which files will change, in 2-3 lines.
- Make the smallest change that works. Don't refactor unrelated code.
- Keep replies short. No long summaries.

## Scope

- Change only what was asked. Anything noticed outside the request is reported
  and offered, not fixed on the side.
- Never commit `.env`, a Client ID, tokens, or anything personal (emails,
  paths, account names). The README is user-facing: plain steps, no jargon.

## Layout

- `main.js`: the main process: the window, sign-in and tokens, menu bar.
- `webamp-spotify.js`: connects Spotify to Webamp's controls; Web API calls.
- `player.js`: the Web Playback SDK (playback).
- `test/mock/*.test.js`: the player against a fake Spotify in a page
  (`test/mock/page.html`).
- `test/app/*.test.js`: the real main process and sign-in screen, Spotify
  faked.
- `test/smoke/smoke.js`: core flows against the real account.
- Run some suites by name: `npm test -- picker lyrics`. Logs and screenshots go
  to `test/.output/`.
