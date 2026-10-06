# RepCheck

A personal gym-tracking web app (PWA) for logging sessions, sets, cardio and daily metrics, and reviewing progress. Built for one person's phone: single-file vanilla JavaScript, no framework, no build step.

## How it works
- `index.html` holds the whole app. State is kept in the browser's local storage and synced to a cloud database when signed in.
- `repcheck-cloud-sync.js` handles sign-in (emailed one-time code) and syncing.
- `sw.js` is the service worker that caches the app shell for offline use.

## Notes
- Private project; not intended for public use or contributions.
- No secrets belong in this repository. Credentials, keys and data exports are never committed (see `.gitignore`).
