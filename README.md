# Pincast status

This repo runs the page at https://status.pincast.fm. Every 5 minutes, GitHub Actions calls each Pincast service, writes what came back to `site/data/status.json`, commits that file, and publishes the page.

The checks run on GitHub's machines, so the page keeps working when one of our own servers is down.

## What gets checked

| Check | What a good answer looks like |
|:-|:-|
| Public list of apps | `GET https://api.pincast.fm/v1/apps`, with no key, answers 200 and a list of apps |
| API read with a test key | Reads one set on the standing test app with the test key. Shows "Not set up" until the `PINCAST_TEST_KEY` secret exists |
| Sign-in server | id.pincast.fm's discovery address answers and names `https://id.pincast.fm/oidc` |
| Docs | docs.pincast.fm answers with its home page |
| Sign-in setup for apps | The service refuses an unsigned call in its own words, which proves it's running. The call names a made-up test app, so nothing real is touched |
| Dashboard sign-in page | pincast.fm/sign-in sends people on to id.pincast.fm |
| MCP server | `https://mcp.pincast.fm/mcp` answers an MCP `initialize`. Shows "Not live yet" until it launches |
| MCP Registry listing | Once a day, the registry's search lists `fm.pincast/mcp`. Shows "Not live yet" until it's published |
| Webhook delivery | A slot, switched off until webhooks go live |

Each call gives up after 10 seconds. A service that doesn't answer, answers with an error, or answers with the wrong thing shows as down.

The page says "Status may be stale" when the newest result is more than 20 minutes old. That's the sign the checks have stopped running.

## Run it yourself

You need Node 22. There's nothing to install.

```sh
npm run check   # runs every check and updates site/data/status.json
npm test        # points each check at dead addresses and stub servers
```

To see the page, serve the `site` folder with any static server, for example `python3 -m http.server -d site 8080`.

## Settings on GitHub

- **Secret `PINCAST_TEST_KEY`**: the test key of the standing test app. The check sends it in a header and never writes it anywhere. It refuses to send anything that isn't a test key.
- **Variable `PINCAST_TEST_SET`** (optional): the set the test-key check reads. It reads `status-check` when this isn't set.
- **Pages**: under Settings, then Pages, the source is "GitHub Actions" and the custom domain is `status.pincast.fm`.

## Changing a check

The checks live in `check/checks.mjs`, one entry each. When the MCP server goes live, set its `live` to `true` so a failure shows as down. When webhooks go live, give the webhook slot its address and set `enabled` to `true`.

The page is `site/index.html`, one file with no build step. Nothing secret goes in this repo or on the page: no key, no token and no private address.
