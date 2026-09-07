# mudlet-web-moved

A holding page for **mudlet-web.mudlet.org**, the address Mudlet Web used before it
moved to **[web.mudlet.org](https://web.mudlet.org/)**.

GitHub Pages allows one custom domain per repository, so the old address cannot be
served by [Mudlet/mudlet-web](https://github.com/Mudlet/mudlet-web) alongside the new
one. This repository claims the old domain and serves a notice pointing at the new
address. It does not navigate on its own: people arrive here holding an old
bookmark, and the notice is the point. The link across preserves the path and
query string, so deep links keep working when it is followed.

It also unregisters the service worker the old deployment left registered on this
origin. Browser storage (profiles, maps, logs) is deliberately left alone.

Retire this repository once the old address has fallen out of use.
