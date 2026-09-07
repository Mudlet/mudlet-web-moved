# mudlet-web-moved

A holding page for **mudlet-web.mudlet.org**, the address Mudlet Web used before it
moved to **[web.mudlet.org](https://web.mudlet.org/)**.

GitHub Pages allows one custom domain per repository, so the old address cannot be
served by [Mudlet/mudlet-web](https://github.com/Mudlet/mudlet-web) alongside the new
one. This repository claims the old domain and serves a notice pointing at the new
address. It does not navigate on its own: people arrive here holding an old bookmark,
and the notice is the point. The link across preserves the path and query string, so
deep links keep working when it is followed.

It also unregisters the service worker the old deployment left registered on this
origin. Browser storage is deliberately left alone — see below.

Pages is sourced from **GitHub Actions** here, not a branch, so a push alone deploys
nothing; `.github/workflows/deploy.yml` stages the site files and every file the page
loads has to be named in it.

## The rescue exporter

Browser storage is keyed per address. Moving to `web.mudlet.org` therefore left every
profile, script, trigger, package and map sitting on **this** origin, reachable by
nothing — the app that used to read them is no longer served here. `export.js` is the
way back out: it walks this origin's storage and writes it to one JSON file the user
can keep and, later, import on the new address.

What it collects:

| Source | Holds |
| --- | --- |
| `localStorage` (every key) | the profile list, global client settings, per-profile command history and stopwatches, and the (already encrypted) credential vault |
| `mudix_vfs_<connectionId>` | one database per profile: scripts, aliases, triggers, timers, keybindings, buttons, packages, fonts, sounds |
| `mudix_maps` | Mudlet binary map data |
| `mudix_logs` | session logs — opt-in, and usually by far the largest part |
| `mudix_folder_handles` | **not exported.** A linked local folder is a browser permission, not data; it cannot be re-granted on another origin. Re-link the folder there. |

Database names are `mudix`-prefixed because the project kept its pre-rename storage
names on purpose — renaming them would orphan existing profiles, which is the very
problem this page exists to solve. localStorage is less tidy (command history is
`cmd.history.<connectionId>`, with no prefix), so every key there is taken rather than
a curated list that would silently drop the next one someone adds.

The importer on the new address lives in
[Mudlet/mudlet-web](https://github.com/Mudlet/mudlet-web) as `src/import/backupImport.ts`,
reached from **Import backup…** on the profile screen. It does *not* restore the
credential vault: a passkey unlocker is bound to the address it was created on, so a
restored vault could be permanently unopenable. Saved logins have to be entered again.

### File format

`mudlet-web-backup` version 1 — a verbatim dump, not a tidied export. The shapes it
contains are internal to the app and keep changing; a faithful copy can be replayed
into whatever the importer needs, while anything summarised away would be lost.

```jsonc
{
  "format": "mudlet-web-backup",
  "version": 1,
  "createdAt": "2026-09-07T12:00:00.000Z",
  "origin": "https://mudlet-web.mudlet.org",
  "userAgent": "…",
  "localStorage": { "mudix_v1": "<raw string>" },
  "indexedDB": {
    "<database>": {
      "version": 1,
      "stores": {
        "<store>": {
          "keyPath": null,          // replay with put(value, key) when null,
          "autoIncrement": false,   // otherwise put(value)
          "indexes": [{ "name": "sessionId", "keyPath": "sessionId", "unique": false, "multiEntry": false }],
          "records": [{ "key": "…", "value": "…" }]
        }
      }
    }
  },
  "skipped": [{ "where": "mudix_folder_handles", "why": "…" }]
}
```

Values are plain JSON wherever JSON can hold them. Anything structured clone carries
that JSON cannot is wrapped in a `$`-tagged object, and an importer has to unwrap
these: `{"$":"ArrayBuffer","v":"<base64>"}`, `{"$":"View","ctor":"Uint8Array","v":"<base64>"}`,
`{"$":"Date","v":"<iso>"}`, `{"$":"Map","v":[[k,v]]}`, `{"$":"Set","v":[…]}`,
`{"$":"bigint","v":"…"}`, `{"$":"undefined"}`, `{"$":"number","v":"Infinity"}`, and
`{"$":"unsupported","kind":"…"}` for anything that could not be carried at all. Object
keys are encoded the same way, so a key can be a string, a number, or a tagged value.

`skipped` is advisory and always present: it records what was left out and why, so a
short export is explicable rather than mysterious.

### Tests

```
npm install
npx playwright install chromium
npm test
```

Two suites, both driving the real page in a real browser against storage seeded to
match the old deployment's shapes: `tests/export.test.mjs` covers the normal path
(binary round-trips, in-line and out-of-line keys, index metadata, logs opt-in, and
that exporting changes nothing), and `tests/export-fallback.test.mjs` covers Firefox,
which has no `indexedDB.databases()` and so has to probe known names — without leaving
empty databases behind on an origin we are trying to leave clean.

Retire this repository once the old address has fallen out of use.
