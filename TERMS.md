# Using Commerce Bench on real sites

Commerce Bench drives a browser on public retail sites the way one shopper would. Keep it that way.

## What the harness does and does not do

- It stops before payment. Tasks carry no card details, and the harness blocks card tokenization and order requests it recognises.
- It checks out as a guest. It does not sign in, create accounts or use saved accounts.
- It does not buy anything. If a run ever reaches an order confirmation, that run is recorded as a `guard_breach`. Check the site for an order and cancel it.

## What we ask of you

- Run at low volume. The default is one site at a time and three runs per site. Do not use this for load testing, scraping or price monitoring.
- Follow each site's terms of use. You are responsible for the runs you start, including runs through a cloud browser or a proxy.
- Use shopper details you are allowed to use. The bundled details are placeholders. Do not use another person's real details.
- Do not add card details to tasks, shopper files or agent prompts.
- Do not remove or weaken the payment guard and publish the results as Commerce Bench results.

## Publishing results

- Say which browser and which track (`observed` or `reported`) produced each number.
- Publish the outcome labels with the pass rate. A pass rate with no reasons hides the bot walls and the false completions.
- Retailer names in results describe what one browser saw on one day. They are not a statement about the retailer's product or service.

## Reporting a problem

If the harness lets a payment or an order through, open an issue with the run folder (remove anything private first). That is the most important kind of bug here.
