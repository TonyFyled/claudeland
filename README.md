# Claudeland

A shared voxel island. Describe a build, Claude makes it block by block while you watch, and everyone who visits can walk around it. Claude's take on Google's GeminIsland.

## How it works

- **`index.html`** is the whole island: Three.js terrain, the builds, fly and walk modes, and the builder sheet. The island grows a new ring of plots as it fills up.
- **`api/generate.js`** sends the visitor's idea to Claude through Vercel AI Gateway and streams the blueprint back line by line, so the build assembles live. Every finished result is signed.
- **`api/builds.js`** lists, places and removes builds. Only signed results from `/api/generate` can be placed, so everything on the island was made by Claude.
- **`lib/store.js`** keeps all builds in one private Vercel Blob file and updates it with conditional writes, so builds placed at the same moment never overwrite each other. The build list is cached on Vercel's CDN and cleared whenever it changes.
- **`lib/seeds.js`** holds six starter builds, written the first time the island is empty.

Builds are a small voxel language (boxes, walls, cylinders, cones, roofs and moving parts) that Claude writes one instruction per line. The prompt is in `lib/shared.js`.

| Mode | Model |
| --- | --- |
| Detailed | `anthropic/claude-sonnet-5.5` |
| Fast | `anthropic/claude-haiku-5.5` |

## Deploy on Vercel

1. Import this repo as a new project (no framework, no build command).
2. Under **Storage**, create a **private** Blob store and connect it to the project. That adds `BLOB_READ_WRITE_TOKEN`.
3. Add two environment variables:
   - `CLAUDELAND_SECRET`: any long random string. It signs Claude's results.
   - `CLAUDELAND_ADMIN_KEY`: a long random string only you know, for owner mode.
4. Deploy. AI Gateway signs in with the project's OIDC token, so no API key is needed.
5. Set an AI Gateway budget for the project so spend can't run away.

Optional settings: `AI_GATEWAY_API_KEY` (to run outside Vercel), `CLAUDELAND_BUILDS_PER_IP` (default 6 builds per 15 minutes per visitor) and `CLAUDELAND_BUILDS_PER_HOUR` (default 200 per server instance).

## Owner mode

Open the site with `#admin` at the end of the address, paste your `CLAUDELAND_ADMIN_KEY` and save it. On that device you can then remove any build and place build codes.

Visitors can remove only the builds they placed from their own browser.

---

A fan-made project. Not affiliated with Anthropic.
