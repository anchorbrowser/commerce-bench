# Let a coding agent write your adapter

Commerce Bench talks to your shopping agent through a small adapter: a program that reads one task as JSON and prints one result as JSON. If you already have a shopping agent, a coding agent can write that adapter for you.

1. Clone this repo next to your agent's code and run `npm install` and `npx playwright install chromium`.
2. Open your coding agent in a folder where it can read both this repo and your agent.
3. Paste the prompt below. Fill in the two lines at the top.
4. To test on a cloud browser too, set an Anchor key first. See [Run it on Anchor](#run-it-on-anchor).

Read the adapter before you run it on real stores. The harness blocks payment requests at the network, but the adapter is your code and you are the one running it.

## The prompt

```text
I want to test my shopping agent with Commerce Bench, the harness in this repo.

My agent: <where the code lives, and how it is started>
How it drives a browser: <for example Playwright, Puppeteer, a CDP URL, or its own hosted browser>

Write an adapter that lets the harness run my agent. Work in this order.

1. Read these files first. They are the contract, so follow them over anything you assume.
   - README.md, the sections "Connect your agent", "What it measures" and "Two tracks"
   - schema/agent-task.schema.json and schema/agent-result.schema.json
   - examples/llm-agent.ts and examples/agents/llm-claude.json, a complete working adapter
   - agents/example-command.json and agents/example-http.json, the two agent file templates
   - TERMS.md

2. Pick the track and say which one you picked and why.
   - "observed": my agent can attach to a browser the harness gives it, through task.browser.cdp_url. Use this whenever it is possible. The harness watches that browser and grades from what it sees.
   - "reported": my agent only runs in its own browser that the harness cannot see. Then the adapter must save at least one real screenshot of the furthest page into task.evidence_dir and list it under "evidence" in the result. A reported run with no image does not pass.

3. Write the adapter as one small program.
   - Use the "command" adapter unless my agent is already an HTTP service. The task arrives as one JSON document on stdin. Print the result as the last JSON on stdout. Send logs to stderr.
   - Pass my agent the task's goal, start_url, rules, shopper and stop_at. Use the shopper details exactly as given. They are placeholders.
   - On the observed track, connect to task.browser.cdp_url, use the context and page that are already open, and leave the browser open when you finish.
   - Stop before task.deadline_s runs out, and still print a result.
   - Never add a payment card, never click a button that places an order, and do not change or remove any rule in the task. Do not edit anything under src/, tasks/ or shoppers/.

4. Build the result honestly.
   - status is "completed", "blocked" or "failed".
   - claimed_stage is the furthest stage the agent really reached: product, cart, checkout or shipping. If you are not sure, claim the lower stage. The harness compares the claim with what the browser showed, and a claim that goes further than the evidence is graded false_completion.
   - reported_total is the order total read from the page, with its currency. Leave it out if the agent did not read one.
   - When the agent stops early, set failure.code to the closest of: bot_detected, captcha_required, login_required, product_not_available, add_to_cart_failed, customer_details_rejected, delivery_not_available, website_unavailable, timeout. Put a short reason in failure.message.
   - Add steps and cost_usd if my agent can report them.

5. Write the agent file as my-agent.json in the repo root, with name, track, adapter and command (or url). If the adapter needs an API key, read it from an environment variable and name that variable in "notes". Never write a key into a file.

6. Check your work, in this order, and show me the output of each step.
   - npm run selftest
     This proves the harness itself works on this machine. It does not use my agent.
   - npm run bench -- run --agent my-agent.json --site ikea.com --runs 1 --headed
     One store, one run, with the browser window visible.
   - Open results/my-agent/report.html and read the row for that run. Tell me the outcome label, the furthest stage the harness saw, and whether it matches what my agent claimed.
   If the run ends as harness_error, the adapter or the setup is broken. Fix that before anything else. Any other label is a real result, including a failure, so report it as it is and do not tune the adapter to hide it.

7. If the environment variable ANCHORBROWSER_API_KEY is set, run the same store once more on an Anchor cloud browser and compare the two rows. Check only that the variable is set. Never print it or write it to a file.
   npm run bench -- run --agent my-agent.json --browser anchor --anchor-config configs/anchor/default.json --site ikea.com --runs 1 --out results/my-agent-anchor --label my-agent@anchor
   If it is not set, skip this step and tell me how to set it.

8. Stop there. Do not start a run across all stores. Tell me the command for it and let me decide:
   npm run bench -- run --agent my-agent.json --runs 3
```

## Run it on Anchor

Many stores turn a laptop browser away before your agent does anything. The same adapter runs unchanged on an [Anchor](https://anchorbrowser.io) cloud browser, so you can see how much of a result is the browser and how much is the agent.

**1. Get a key and set it.** Create one at [app.anchorbrowser.io/api-keys](https://app.anchorbrowser.io/api-keys). The harness reads it from the environment and nowhere else:

```sh
export ANCHORBROWSER_API_KEY=...
```

Keep it out of the agent file, the adapter and the prompt. The Free plan is enough for `default.json`.

**2. Run on Anchor.** The harness creates the session, hands your adapter its CDP URL in `task.browser.cdp_url`, saves the session recording next to the run and closes the session afterwards. Your adapter does not call the Anchor API.

```sh
npm run bench -- run --agent my-agent.json --browser anchor --anchor-config configs/anchor/default.json --site ikea.com --runs 1
```

Swap the config file to change the session: `stealth.json`, `residential.json` or `mac.json`. What each one turns on, and which plan it needs, is in the README under [Compare browsers](../README.md#compare-browsers).

**3. Optional: give your coding agent the Anchor MCP server.** The harness does not need it. It is useful when you want the coding agent itself to open a page, look at a store, or check a session while it debugs the adapter.

Add the server by URL and sign in when the client asks:

```sh
claude mcp add --transport http anchor https://api.anchorbrowser.io/v1/mcp
```

For Cursor and other clients that read a JSON config, add this to `.cursor/mcp.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "anchor": {
      "url": "https://api.anchorbrowser.io/v1/mcp"
    }
  }
}
```

Signing in is the simplest way and puts no key in a file. For CI or a client that cannot open a sign-in page, send the key as an `anchor-api-key` header instead, and keep that config file out of git. The [Anchor MCP docs](https://docs.anchorbrowser.io/advanced/mcp) list every client and the other servers.

## What to expect

A first run often ends with a label other than `pass`. That is the harness doing its job. `bot_detected:<vendor>` means the store turned the browser away before any shopping, which is about the browser, not your agent. See [Compare browsers](../README.md#compare-browsers) for running the same agent on a different browser. `false_completion` means the agent said it got further than the browser showed, and that one is worth fixing first.

The full list of labels is in the README under [What it measures](../README.md#what-it-measures).
