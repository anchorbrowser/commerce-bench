# Contributing

Thanks for looking. The most useful contributions are small and come with evidence: a run that was graded wrong, a store task that no longer works, or a new store.

## Before you start

```sh
npm install
npx playwright install chromium
npm run selftest
```

`selftest` runs the grader against a local mock shop. If it does not pass on a clean checkout, open an issue with the output before changing anything.

Read [TERMS.md](TERMS.md). Low volume, guest checkout, no purchases. That applies to anything you run while working on a change.

## Report a run that was graded wrong

This is the most valuable kind of issue. Stage detection uses general rules, and real stores keep finding the gaps.

Open an issue with:

- the store and the command you ran
- the outcome label the harness gave, and what you think it should have been
- the run folder, or at least `run.json` and the last screenshot from it

Look through the files first. Shopper details in the bundled files are placeholders, but if you used your own with `--shopper`, remove them. Do not attach API keys, CDP URLs or cookies.

## Fix or add a store task

Each store is one JSON file in `tasks/`. The format is in the README under [Tasks](README.md#tasks).

- Pick a product that is cheap, in stock most of the time, and can be bought as a guest.
- `product.match` should be the fewest words that identify the product on the page and in the cart.
- Keep `stop_at` at `shipping`. Payment is never a target.
- Run `npm run validate`, then one real run of the store, and say in the pull request what the run ended as:

```sh
npm run bench -- run --agent examples/agents/llm-claude.json --site <store> --runs 1
```

A store that needs an account, or that has no guest checkout, is still worth recording. Say so in the pull request.

## Add an agent

An agent file is a few lines of JSON. See [Connect your agent](README.md#connect-your-agent), and [docs/adapter-prompt.md](docs/adapter-prompt.md) if you want a coding agent to write the adapter.

Agent files for your own agent do not need to live in this repo. If you want one included under `examples/agents/`, it has to run for someone else: no private endpoints, keys read from environment variables, and a `notes` line that says what it needs.

For a consumer assistant on the reported track, never run an account that has a saved card. Mark it `needs_account` instead. See [Consumer assistants](README.md#consumer-assistants).

## Change the harness

- Node 22.18 or newer. The code is TypeScript run directly by Node, so no build step.
- Keep the two rates separate. False completion and guard breach are never folded into one score.
- Do not weaken the payment guard or the request blocking in `src/probe.ts` and `src/evidence.ts`. A change there needs a selftest case that shows why.
- A change to grading needs a test, and a new selftest case if it changes what counts as a pass.

Before you open a pull request:

```sh
npm run typecheck
npm test
npm run selftest
npm run validate
```

## Results

The files in `results/published/` are generated from recorded runs. Please do not edit them by hand. If you ran the bench yourself and want to share what you found, open an issue and attach your `leaderboard.json`.

## Pull requests

Small and focused. One change per pull request, a title that says what changed, and a short note on how you checked it. By contributing you agree that your work is licensed under [Apache-2.0](LICENSE).
