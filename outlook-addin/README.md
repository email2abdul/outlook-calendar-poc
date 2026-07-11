# Outlook Add-in — "BIS Brief"

A ribbon button on a calendar meeting → task pane showing that meeting's BIS
pre-meeting brief (same body as the emailed brief and the in-app one).

## How it works

```
Outlook meeting (ribbon "BIS Brief" button)
  → task pane   GET /addin/taskpane        (served by our server, Office.js)
  → reads the meeting's subject + attendee emails via Office.js
  → fetch        GET /embed/meeting-brief?token=…&emails=…&subject=…
  → server matches emails → physician(s) in the BIS directory
     → returns the pre-meeting brief HTML (graph.physicianBriefHtml)
     → no email match → physician suggestions from the subject (tap to load)
```

- Files: `outlook-addin/manifest.xml`, `src/routes/addin.routes.js` (task pane
  HTML + CSP + token injection), `public/addin/taskpane.js` (Office.js logic),
  `public/addin/icon-*.png`, and `GET /embed/meeting-brief` in
  `src/routes/embed.routes.js`.
- **No new auth.** The task pane has no Outlook session, so `/embed/meeting-brief`
  is gated by the shared embed token — `ADDIN_TOKEN`, falling back to
  `DYNAMICS_EMBED_TOKEN`. Set one on the server.

## Server env

- `PUBLIC_BASE_URL` — where the app is hosted (default
  `https://agentpoc.insightmonk.com`). Must be **HTTPS** (Outlook requires it).
- `ADDIN_TOKEN` **or** `DYNAMICS_EMBED_TOKEN` — the token the task pane sends.
- `ADDIN_FRAME_ANCESTORS` — optional; defaults to the Outlook web hosts so
  Outlook can iframe the task pane.

> If you host somewhere other than `https://agentpoc.insightmonk.com`, replace
> every occurrence of that URL in `manifest.xml` with your `PUBLIC_BASE_URL`.

## Sideload (testing, no admin needed)

**Outlook on the web** (also works in new Outlook desktop):

1. Open <https://outlook.office.com/mail> (or outlook.office365.com), sign in.
2. Settings ⚙ → **General → Manage add-ins** (or **Get add-ins**).
3. **My add-ins → Custom add-ins → Add a custom add-in → Add from file…**
4. Choose `outlook-addin/manifest.xml`. Confirm.
5. Open any **calendar meeting** → look for the **BIS Brief** button on the
   ribbon / the "…" (more actions) menu → click it → the brief opens in a pane.

To update after changing the manifest: remove the custom add-in and re-add it.

## Notes / limits

- **Outlook mobile is not supported** for calendar/appointment add-in buttons —
  a Microsoft platform limitation, not ours. Use Outlook web / desktop.
- Demo/coffee-sales attendees won't match the medical directory — test with a
  real physician email (e.g. `afrost@pennmedicine.upenn.edu`).
- The `Id` GUID in the manifest identifies this add-in; keep it stable across
  updates (change it only to install a separate copy side-by-side).
