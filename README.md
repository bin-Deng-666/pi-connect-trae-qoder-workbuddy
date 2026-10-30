# pi-connect-trae-qoder-workbuddy

Bring your **Trae**, **Qoder** and **WorkBuddy** accounts into [pi](https://pi.dev) — one local gateway, one OpenAI-compatible shape, and each account's remaining credits in the footer.

```
pi  ──▶ 127.0.0.1:8798/trae/v1    ──▶ Trae
     ──▶ 127.0.0.1:8798/qoder/v1   ──▶ Qoder
     ──▶ copilot.tencent.com/v2    ──▶ WorkBuddy   (direct: already OpenAI-shaped)
```

## Why this exists

All three clients ship their own chat APIs and their own model catalogs, and none of them speak OpenAI's protocol in the parts that matter. Trae wants a `Cloud-IDE-JWT` header, a `config_name` **and** a `function` per request, and streams `event: output` frames. Qoder wants a signed cosy bearer, a custom base64 re-encoding of the whole body, internal short model ids (`dmodel`), and double-wrapped SSE frames. WorkBuddy, unusually, is already compatible — so it is not proxied at all; only its *billing* endpoint needs translating.

This project translates the two that need it, leaves the one that does not alone, and puts the three balances behind a single endpoint.

**It is a bridge, not a bypass.** Every request is made with the credentials your own desktop clients already hold, against the same endpoints those clients use, and consumes the same credits they would. Nothing here grants access you did not already have.

## What you get

- **One process, one port.** A single gateway serves both incompatible providers instead of two shims that drift.
- **Real usage numbers.** Prompt/completion/cache tokens are forwarded, so pi's footer shows actual context occupancy and cache hit rate instead of `?/200k`.
- **Real context windows.** Trae's 1M window comes from naming the right wire function; Qoder's comes from using the largest tier the model advertises.
- **Credits for all three.** `GET /credits` answers in one shape; the footer extension renders the current provider's balance next to the context reading.
- **No secrets on disk.** Credentials are read from the clients' own stores on every call — never copied, never cached by this project.

## Quick start

Requires **Node ≥ 22.5** (for `node:sqlite`).

```bash
git clone https://github.com/<you>/pi-connect-trae-qoder-workbuddy.git
cd pi-connect-trae-qoder-workbuddy

# 1. Build the Trae model catalog from the installed client
npm run catalog

# 2. Start the gateway
npm start
# pi-connect gateway: http://127.0.0.1:8798  providers=trae,qoder

# 3. Check what it can see
curl -s localhost:8798/healthz
curl -s localhost:8798/credits
```

Then merge [`examples/models.example.json`](examples/models.example.json) into `~/.pi/agent/models.json` and load the footer extension:

```bash
pi install ./pi-connect-trae-qoder-workbuddy
```

Full walkthrough: [`docs/setup.md`](docs/setup.md). Per-provider details, including what each one needs from your machine: [`docs/providers.md`](docs/providers.md).

## Routes

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness plus the list of proxied providers |
| `GET /providers` | The same list as a bare array |
| `GET /trae/v1/models` | Trae catalog in OpenAI shape |
| `GET /qoder/v1/models` | Qoder catalog in OpenAI shape |
| `POST /<provider>/v1/chat/completions` | Chat, streaming or not |
| `GET /credits` | Every provider's remaining balance |
| `GET /credits/<provider>` | One provider's balance |

## Layout

```
.
├── bin/
│   └── catalog.mjs          # build the Trae catalog from the installed client
├── src/
│   ├── config.mjs           # every host path and constant, and their env overrides
│   ├── credits.mjs          # three billing shapes -> one report
│   ├── gateway.mjs          # HTTP front door: SSE framing, usage, error mapping
│   ├── providers/
│   │   ├── qoder.mjs        # cosy protocol -> OpenAI
│   │   └── trae.mjs         # Trae protocol -> OpenAI
│   └── util.mjs             # main-module detection
├── extensions/
│   └── credits/index.ts     # pi footer: remaining credits
├── examples/
│   └── models.example.json  # models.json fragment to merge
├── docs/
│   ├── providers.md         # per-provider wire notes and requirements
│   └── setup.md             # end-to-end install
└── test/
    └── gateway.test.mjs     # stream contract, no network
```

## Configuration

Everything host-specific is in [`src/config.mjs`](src/config.mjs) and can be overridden by environment variable:

| Variable | Default | Meaning |
|---|---|---|
| `PI_CONNECT_PORT` | `8798` | Gateway port |
| `PI_CONNECT_HOST` | `127.0.0.1` | Bind address — loopback by default, deliberately |
| `PI_CONNECT_PI_HOME` | `~/.pi/agent` | Where pi keeps `models.json` |
| `DSH_HOME` | `~/.dsh` | Where the desktop clients' plugin vaults live |
| `PI_CONNECT_TRAE_CATALOG` | `$PI_CONNECT_PI_HOME/trae-models.json` | Generated Trae catalog |
| `PI_CONNECT_TRAE_CREDENTIALS` | `$DSH_HOME/.trae-auth.cn.json` | Trae credential file |
| `PI_CONNECT_QODER_CREDENTIALS` | `$DSH_HOME/.qoder-accounts.cn.json` | Qoder credential file |

## Development

```bash
npm test          # gateway contract tests, no network
npm run lint      # syntax check every module
npm run check:trae   # live: read credentials, catalog and balance
npm run check:qoder  # live: same for Qoder
```

The tests replace the adapters with fakes and assert the byte shape of the SSE stream — specifically that exactly one usage-bearing chunk is emitted, because a gateway that streams text correctly but drops usage leaves pi's footer stuck on `?/200k`, which looks like a pi bug and is not one.

## Licence and scope

MIT — see [LICENSE](LICENSE).

This is an unofficial client. It is not affiliated with, endorsed by, or supported by ByteDance (Trae), Qoder, or Tencent (WorkBuddy). It replays the wire formats those clients use; when a vendor changes a format, the matching adapter breaks until it is updated. Use it with accounts you own, under those services' terms.
