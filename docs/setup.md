# Setup

End-to-end install. Takes about ten minutes; most of it is waiting for the desktop clients to be logged in.

## 0. Prerequisites

- **Node ≥ 22.5** — `bin/catalog.mjs` uses `node:sqlite`, which arrived in 22.5.
- **At least one desktop client installed and logged in.** The gateway holds no credentials of its own; it reads the ones your clients already refreshed. Which client, and what it leaves on disk, is in [`providers.md`](providers.md).
- **pi installed and working** — `pi --version`.

```bash
node --version    # v22.5.0 or newer
```

## 1. Get the code

```bash
git clone https://github.com/<you>/pi-connect-trae-qoder-workbuddy.git
cd pi-connect-trae-qoder-workbuddy
```

There are no runtime dependencies to install. That is deliberate: the gateway is built on `node:http` and `fetch`, so it cannot break because a transitive package changed.

## 2. Build the Trae catalog

Only needed if you use Trae. Run it once, and again whenever Trae ships new models.

```bash
npm run catalog
# wrote 18 models to ~/.pi/agent/trae-models.json
```

If it fails with `Trae database not found`, start the Trae app once so it caches its model list, then retry. To see what it would write without writing:

```bash
node bin/catalog.mjs --stdout | head -40
```

Why a generated file exists at all is explained in [`providers.md`](providers.md#trae) — the short version is that Trae names each model twice per request and the second name cannot be derived from the first.

## 3. Start the gateway

```bash
npm start
# pi-connect gateway: http://127.0.0.1:8798  providers=trae,qoder
```

Verify:

```bash
curl -s localhost:8798/healthz
# {"ok":true,"providers":["trae","qoder"]}

npm run credits
# trae: 0 credits (you)
# workbuddy: 461.27 credits (you)
# qoder: 0 credits (you)
```

A provider reporting an error instead of a number means its credential is missing or expired — see the matching section of [`providers.md`](providers.md). The others keep working; a single failure never blanks the whole report.

### Keep it running

The gateway must be up whenever pi is. On macOS, a launch agent:

```bash
./scripts/install.sh
```

That writes `~/Library/LaunchAgents/com.pi-connect.gateway.plist`, loads it, and stops it again on logout. To watch it:

```bash
tail -f ~/.pi/agent/pi-connect.log
```

`scripts/install.sh --uninstall` removes the agent and its log.

## 4. Configure pi's models

Merge the providers you actually use into `~/.pi/agent/models.json`. Start from [`examples/models.example.json`](../examples/models.example.json) — it has all three, with one model each, so you can delete the sections you do not need.

The essential fields:

```json
"trae": {
  "baseUrl": "http://127.0.0.1:8798/trae/v1",
  "api": "openai-completions",
  "apiKey": "gateway-local"
}
```

`apiKey` is required by pi's schema but ignored by the gateway, which authenticates with the desktop clients' own tokens. Any non-empty string works for Trae and Qoder — but **WorkBuddy is called directly**, so its entry has to carry a real token.

### Filling the model list

`GET /<provider>/v1/models` returns what the provider actually offers:

```bash
curl -s localhost:8798/qoder/v1/models | jq -r '.data[].id'
```

Copy the ids you want into your `models.json` entries. Before adding an entry, note that:

- **`contextWindow` should be the largest window the model advertises**, not its default. Trae's default is 200K but its ceiling is 1M; Qoder's tiers are 200K/400K/1M. Reporting the default caps every long turn for no reason.
- **`id` for Qoder is the display name** (`GLM-5.3`, not `gmodel`). Pi renders `model.id` in the picker and footer, and the adapter resolves it back to the internal short code.
- **`maxTokens` should be the model's own output limit**, not a round number. They range from 32K to 131K across these catalogs.

## 5. Install the footer extension

```bash
pi install ./pi-connect-trae-qoder-workbuddy
```

Restart pi. The footer gains a `◆ <balance>` segment next to the context reading for whichever provider is selected:

```
↑12.5k ↓609k R109M CH99.6% 17.8%/1.0M (auto) ◆ 461.3
```

Commands: `/credits` (all three, with accounts), `/credits-off`, `/credits-on`.

### Why the extension redraws the whole footer

Pi has one custom footer slot and the last extension to claim it wins. If you also run `agent-personal-memory`, it claims the same slot and right-aligns its status on the path line. This extension renders the same three rows memory does — path, stats, other statuses — so neither pushes the other's content onto an extra line. If your footer looks rearranged, that interaction is the place to look.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Footer shows `?/200k` while streaming works | The gateway is not the one running — an older build that dropped usage | Restart it, confirm `curl localhost:8798/healthz` |
| `no Trae credential at …` | The client is not logged in, or the vault is elsewhere | Log in; or set `PI_CONNECT_TRAE_CREDENTIALS` |
| `Qoder jobToken exchange failed: HTTP 403` | PAT expired | Re-add the PAT in the Qoder plugin's settings |
| Trae returns empty content with `finish_reason: stop` | Out of credits, not a protocol failure | Check `/credits` |
| Model missing from the picker | Not in `models.json`, or in the catalog but not in your `models.json` | Compare with `GET /<provider>/v1/models` |
| `Trae database not found` | App never started, or a non-default install path | Start the app; or `node bin/catalog.mjs --app "<dir>"` |

## Environment

Every path is overridable — see the table in the [README](../README.md#configuration). The one worth calling out: `PI_CONNECT_HOST` defaults to `127.0.0.1` on purpose. This process holds live session tokens and can spend your credits; binding it to a public interface would expose both. Change it only if you understand that.
