# Winify: rules for every session

Winify is a Winamp-style Spotify player (Electron + Webamp + the Spotify Web
Playback SDK). User-facing docs: README.md. How it is built: DEVELOPMENT.md.

## Before every commit

1. Run the full test suite: `npm test` (about 15 minutes; no Spotify requests).
2. Run the smoke test against the real Spotify: `npm run smoke` (about a
   minute and a half, at most 30 Web API requests). It needs Winify quit and a
   remembered sign-in; ask the user before running it, since it plays music.
3. Never commit with a failing test, in either. If a test's expectation is
   genuinely out of date (the requested behaviour changed it), update the test
   in the same commit and say which check changed and why.

## After every change

In the report to the user, list which existing features were re-checked, and
how (which suites, which smoke checks, anything checked by hand), and say
plainly what was not checked.

## Testing

- Test against the mocks first (`test/mock`, `test/app`). They fake Spotify
  and send it nothing.
- Real Spotify requests count toward the user's rate limit (a 429 can block
  playback for hours). Keep them to the minimum that answers the question:
  one request, never loops or repeated timing samples. Before running anything
  that talks to the real Spotify, state how many requests it will send.
- Never refresh the stored Spotify token outside Winify: Spotify replaces the
  refresh token on every use, which can sign the running Winify out.

## Scope

- Change only what was asked. Anything noticed outside the request is reported
  and offered, not fixed on the side.
- Never commit `.env`, a Client ID, tokens, or anything personal (emails,
  paths, account names). The README is user-facing: plain steps, no jargon.

## Layout

- `test/mock/*.test.js`: the player against a fake Spotify in a page
  (`test/mock/page.html`).
- `test/app/*.test.js`: the real main process and sign-in screen, Spotify
  faked.
- `test/smoke/smoke.js`: core flows against the real account.
- Run some suites by name: `npm test -- picker lyrics`. Logs and screenshots go
  to `test/.output/`.
