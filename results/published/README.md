# Published results, 24 November 2026

Results from Commerce Bench. One agent, one network per setup, runs from 23 and 24 November 2026. Read the limits at the bottom before quoting anything.

## Files

| File | What it holds |
|---|---|
| `runs-anchor-best.jsonl` | For each store, the runs from the Anchor setup that did best there. The `setup` and `config` fields name the setup |
| `runs-anchor-mac.jsonl` | The reference agent on Anchor Mac hardware, 30 stores, 3 runs each |
| `runs-anchor-default.jsonl` | The same agent on an Anchor default session, 30 stores, 3 runs each |
| `runs-anchor-stealth.jsonl` | The same agent with proxy, extra stealth and captcha solving, on the stores the lighter setups did not finish |
| `runs-anchor-residential.jsonl` | The same agent with a residential proxy and stealth, on the same kind of stores |
| `runs-local-chromium.jsonl` | The same agent on local headless Chromium, 30 stores, 3 runs each |
| `best-setup.json` | Per store: the Anchor setup picked, its config file, passes, graded runs and whether the store finished |
| `index.json` | Runs, passes and stores finished per file, and a list of every batch in `all-runs/` |
| `all-runs/` | Every run row of every pass, unfiltered. See below |
| `front-door.json` | Each store start page opened once per browser setup, no agent. `opened`, or the outcome label that came back |
| `recordings/` | Six Anchor session recordings as short GIFs, 10x speed |

Each line of a `.jsonl` file is one run record as described in `schema/`, plus `setup`, `config` and `batch`. Session ids are removed, checkout ids in URLs are replaced with `[id]`, and browser connection URLs are removed.

A store counts as finished when more than half of its graded runs pass. Runs labelled `harness_error` (the harness or the browser failed, for example a browser that stopped answering) are not graded.

The grid and the tables in the main README are built from these files:

```sh
node scripts/results-matrix.mjs      # agent runs: grid images and the README results block
node scripts/front-door-matrix.mjs   # start pages, from front-door.json
```

## All runs

`all-runs/` holds one file per batch of runs, named after the folder the batch ran in (`rerun-v8--mac-gb.jsonl` is `rerun-v8/mac-gb`). Nothing is left out: failed runs, `harness_error` runs from frozen browsers, and runs that a later pass replaced are all there. Screenshots and recordings are not.

The `runs-*.jsonl` files are picked from these batches:

- **Per setup:** for each store, the latest batch that ran that store on that setup. Within a batch, the last row for each attempt.
- **Best setup per store:** for each store, the Anchor setup with the most passing runs. A finished store always beats an unfinished one. On a tie, the setup whose runs got furthest wins, then the lighter setup, in the order default, stealth, residential, Mac.

Some rows in `all-runs/` were produced before the grader and agent fixes made on 24 November 2026. Those fixes read one-page checkouts, checkout totals and addresses shown back as page text correctly, recover from frozen browsers, and make the reference agent list product controls before site menus. Four tasks (`asos.com`, `diy.com`, `hp.com`, `nike.com`) also got a new product that can be bought as written.

## How these were run

- Agent: `examples/llm-agent.ts`, a small Claude tool-use loop, model `claude-opus-5-5`. The same agent and the same grader produced every row.
- Task: find the named product, add it to the cart, check out as a guest, enter the placeholder shopper details, stop when the store accepts them.
- Browser setups: local headless Chromium, and Anchor sessions created with the files in `configs/anchor/`.
- No run entered a card or placed an order. The harness recorded zero guard breaches.

## Limits

- **Small sample.** Three runs per store per setup, and one visit per cell in `front-door.json`. Stores flip between runs: `smythstoys.com` opened on Mac hardware with a UK exit in the front-door pass and was walled in the agent run an hour later.
- **Best setup is picked after the runs.** It shows which setup to use for a store. It is not one configuration that was run on every store.
- **Geography is mixed in.** Local runs left from a network in India. Anchor sessions left from the US, or the UK where the config file name says so. Part of any gap between local and Anchor is location.
- **One generic config per setup.** No store-specific tuning beyond what Anchor applies itself through `session.domain`.
- **One agent.** A different agent changes every number past the front door.
- **Account-only stores.** `amazon.com` and `walmart.com` ask for a sign-in before checkout. The task asks for guest checkout, so they do not finish on any browser.
- **Front-door labels predate two detector fixes** for a few cells and were re-run where known (`target.com`).
