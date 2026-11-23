# Published results, 23 November 2026

First results from Commerce Bench. One day, one agent, one network. Read the limits at the bottom before quoting anything.

## Files

| File | What it holds |
|---|---|
| `front-door.json` | Each store start page opened once per browser setup, no agent. `opened`, or the outcome label that came back |
| `runs-local-chromium.jsonl` | The reference agent on local headless Chromium, 30 stores, 3 runs each |
| `runs-anchor-default.jsonl` | The same agent on an Anchor default session, 30 stores, 3 runs each |
| `runs-anchor-mac.jsonl` | The same agent on Anchor Mac hardware. In progress, see `index.json` for how many stores it covers |
| `index.json` | Run counts per file |
| `recordings/` | Three Anchor session recordings as short GIFs, 10x speed |

Each line of a `runs-*.jsonl` file is one run record as described in `schema/`. Checkout session ids are replaced with `[id]`.

The store grid in the main README is built from `front-door.json`:

```sh
node scripts/front-door-matrix.mjs
```

## How these were run

- Agent: `examples/llm-agent.ts`, a small Claude tool-use loop, default model.
- Task: find the named product, add it to the cart, check out as a guest, enter the placeholder shopper details, stop when the store accepts them.
- Browser setups: local headless Chromium, and Anchor sessions created with the files in `configs/anchor/`.
- No run entered a card or placed an order. The harness recorded zero guard breaches.

## Limits

- **Small sample.** One visit per cell in `front-door.json`. Three runs per store in the agent files. Stores flip between runs: `smythstoys.com` opened on Mac hardware with a UK exit in the front-door pass and was walled in the agent run an hour later.
- **Geography is mixed in.** Local runs left from a network in India. Anchor sessions left from the US, or the UK where the file name says so. Part of any gap between local and Anchor is location.
- **One generic config per setup.** No store-specific tuning beyond what Anchor applies itself through `session.domain`.
- **One agent.** A different agent changes every number past the front door.
- **Four bad tasks.** The products named for `asos.com`, `diy.com`, `hp.com` and `nike.com` were not purchasable as written, so those stores stop at the product page for a reason that is not the browser or the agent.
- **Front-door labels predate two detector fixes** for a few cells and were re-run where known (`target.com`).
