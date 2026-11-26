# Starter

A Cloudflare Worker named `pincast-status-starter` starts the status checks every 5 minutes, at minutes 3, 8, 13 and so on, because GitHub's own timer kept skipping them. Once a day at 10:23 UTC it also starts the docs checks in pincastFM/pincast-docs-public, unless GitHub's timer ran them in the last 6 hours.

It skips a start when a run began in the last 4 minutes or is still going, so runs never stack.

- `worker.js` is the Worker.
- `worker.test.mjs` holds its tests: `node starter/worker.test.mjs`.

Its one secret, `GITHUB_TOKEN`, is a fine-grained token that can start and read workflow runs on this repo and pincast-docs-public only. It expires 2027-11-25, and a new one goes in before then.
