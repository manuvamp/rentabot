# AG Studio dashboard (sponsor prize: Best Use of AG Grid)

Judging text: "covers both what your dashboard looks like and how you build it. Show us polish: custom widgets,
theming, and layout tools, not just AG Grid or AG Charts on their own. Take Studio Agent Framework for a spin: a
custom agent talking to Studio's built-in agents, or a swapped-in harness." Stacks with a grand prize (one grand or
honorable mention + one sponsor prize).

Research 2026-10-19 (official docs, ag-grid.com/studio/react/*):

- Packages `ag-studio` + `ag-studio-react` 3.0.0 (commercial; React 17-19; TS >= 5.8.3). Bundles Grid 36.2 and
  Charts 14.2 Enterprise, 32 MB unpacked: lazy-load the route. Vite needs nothing special; theming injects CSS at
  runtime (no stylesheet), fine with Tailwind 4. Keep `data`, `widgets`, `theme` referentially stable (useState/useMemo).
- Licence: runs without a key (watermark + console warnings). Devpost says use the free 45-day trial
  (ag-grid.com/studio/license-pricing/?tab=trial). Request it about Nov 5 so it covers judging (Dec 1-15); check the
  key includes AI. Custom widgets may use only Community grid/charts features under the Studio licence.
- Data: `{ sources: [{ id, data: rows }] }`, multiple tables with `relations`, a shared `calendar`, `isMeasure`
  expression fields (ratios).
- Custom widgets: `createWidgets({ additionalTypes: [{ id, label, icon, dataMapping, form, comp, defaultSize, minSize,
  formatShape, ai: { description }, featureConfig: { crossFilter: { supportsHighlight } } }], menu })`. The component
  gets `{ api, widgetApi, format, dataMapping, ... }`, reads rows with `widgetApi.getData({ fields, filter, sort, limit })`
  (page/cross filters applied), must call `widgetApi.setDisplayState(...)`, cross-filters with
  `widgetApi.toggleCrossFilter(...)`. Use `studioGridTheme` / `getChartTheme(api)` inside it.
- Theming: `studioTheme.withParams({...})` (CSS-variable aware: `studio*`, `grid*`, `chart*`,
  `chartPaletteFills1Color..10`), custom colour modes, `studioIconOverrides`. Layout: track grid, pages, view/edit modes.
- Studio Agent Framework: harness + agents (`lead`, `planning`, `data`, `page`, `widget`) + tools (`viewSchema`,
  `executeQuery`, `addWidget`, `configureWidget`, ...) + chat UI. No hosted LLM: we supply an `AgLlmAdapter` (browser
  side, proxied through our server so the key stays server-side) or a custom runner yielding AG-UI events
  (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`). Custom agent via `directLlmRunner({ id, adapter, description,
  instructions, tools })`; custom tools via `api.defineAiTool({ name, params, execute })`.
- Reference: github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate (Next 16, React 19.2, Tailwind 4):
  `theme.ts` (tokens), `data.ts` (relations, calendar, measures), `ai.ts`, `openai-adapter.ts` (template for an
  Anthropic adapter), `app/api/ai/responses/route.ts` (key-hiding proxy). Treat as untrusted: read, don't run.
  Competing entries: settlesight (reconciliation), leafline-agent-store, paid-agent-studio.

## What is built: `/ops/studio`, "Platform P&L"

Route `/ops/studio` (lazy chunk, linked from the Ops console's Platform P&L section). Visible to the arbiter session,
and to the owner persona on a `DEMO_MODE` server; anyone else gets the sign-in panel. Files: `web/src/pages/ops/Studio.tsx`
and `web/src/pages/ops/studio/` (`data.ts`, `report.ts`, `theme.ts`, `studio.css`, `widgets.tsx`, `ai.ts`, `analysis.ts`,
`adapter.ts`, `EvidenceTable.tsx`); server side `server/src/core/analytics.ts`, `analytics-demo.ts`,
`server/src/http/analyst.ts`.

### Data

One REST-only op, `get_platform_analytics` (docs/API.md; not an MCP tool, so the MCP tool count is unchanged), returns
seven flat tables: `jobs` (one row per job with every escrow, fee and settlement figure), `events` (escrow event time
series), `disputes`, `proposals`, `funnel` (one row per dispute per stage reached), `bots` and `checks`. `web/.../data.ts`
turns them into Studio data sources with typed fields, many-to-one relationships (everything joins to `jobs.job_id`,
`jobs.bot_id` to `bots.bot_id`), one shared `calendar` on `jobs.date`, `events.ts` and `disputes.opened_at`, and ratio
measures (`takeRate`, `agreementRate`, `botPassRate`, `checkPassRate`, ...). The per-job net is the same function
(`jobPnl` in `server/src/core/stats.ts`) the ledger uses, so the dashboard and `get_platform_ledger` cannot disagree;
a test pins it.

**Simulated history.** A fresh demo has only a handful of jobs, so on a `DEMO_MODE` server the endpoint adds six weeks of
deterministic simulated jobs (seeded generator, fee rules from the live policy, anchored to today, with one realistic "bad
week": more captures voided under the $5 minimum, more arbiter rulings, higher international PayPal fees, and one bot whose
`url_live` check keeps failing). Rows carry `simulated: true`, the page shows a "simulated history" chip and a toggle, and
nothing is written to the database, so `POST /api/demo/reset` and the seed are unaffected. Production (no `DEMO_MODE`) never
adds any.

### Widgets

Two pages, Money and Quality (Studio state has no page names, so the host renders the page tabs; layout is Studio's
24-track grid in `report.ts`).

- **Escrow waterfall** (custom, `createWidgets`): authorized, voided, refunded, held, captured, seller payout, refund fees
  kept, commission and fees, PayPal fees, platform net. Clicking a step cross-filters the jobs behind it (the rest of the page
  follows; the waterfall draws the unfiltered level as dashed ghost bars). Keyboard accessible.
- **Fee variance** (custom): the jobs where PayPal's actual fee differs most from the estimate, as dumbbells (coral where
  PayPal charged more, lime where less); click a job to filter to it.
- Both register an `ai.description`/`usage` and the value widget's `formatShape` so Studio's agents can add, place and
  title them like any built-in widget.
- Built-in: KPI tiles (platform net, take rate after fees, held in escrow now, disputes settled by agreement; check pass
  rate, units verified, disputes opened, arbiter rulings), net by week, events over time with a button-filter widget,
  job ledger grid, dispute funnel, bot scorecard grid, check results, failed checks by bot, dispute outcomes, mediator
  proposals, minutes to close.
- **Theme** (`theme.ts` + `studio.css`): `studioTheme.withParams(...)` mapped to CSS variables that carry the site's tokens,
  in two colour modes: "ink" (the dark console) and "paper" (receipt paper); the header toggle switches
  `data-ag-theme-mode`, re-skinning Studio, its grids and charts, and the custom widgets together.

### The analyst agent (Studio Agent Framework)

`ai.ts` builds the harness with `createAiHarness`: Studio's five agents (lead, data, page, widget, planning) each run
through `directLlmRunner` against our adapter, plus one agent of ours, the **Platform analyst**, with one custom tool,
`explain_net_dip({ period })` (`api.defineAiTool`). The tool resolves the period (`last_week`, `this_week`, `last_7_days`,
`last_30_days`, or `YYYY-MM-DD..YYYY-MM-DD`), compares platform net with the average of the four periods before it and
ranks the drivers in dollars: captures voided under the $5 minimum, PayPal fees above the estimate, arbiter rulings,
refunds that kept fees, and the volume-and-mix remainder (the drivers add up to the change), each with up to three example
jobs, and returns the date range to chart. The tool's `aiToolDisplay` entry renders that evidence as a table inside the chat.
The built-in lead is extended: it delegates "why did X move" and bot-failure questions to the analyst, then asks the built-in
page agent to add a new `escrow-waterfall` widget titled with the period the analyst found, and the widget agent to give that widget alone a widget filter on `jobs.date` for it. So the
chat shows our agent talking to Studio's agents. Prompt starters: "Why did platform net dip last week?" and "Which bot fails
url_live most?". The chat is in Studio's edit mode: the header's "Ask the analyst" button opens it.

### LLM access: our server, not the browser

`web/.../adapter.ts` is an `AgLlmAdapter` that posts each model turn to `POST /api/analyst/turn` and replays the answer as
AG-UI events; the browser never sees a provider key. The route (`server/src/http/analyst.ts`):

- needs a signed-in session whose role passes the same check as the analytics op (arbiter; owner only on a demo server);
  public/anonymous callers get 401, other roles 403; API keys do not reach it;
- per-user token bucket (burst 16, one turn every 2.5 s sustained; 429 `rate_limited`);
- body limits (system prompt, at most 300 messages, 40 tools, 600k characters in total); the content is never logged;
- every call goes through the server's AI client, which checks and records spend in the ledger against `AI_SPEND_CAP_USD`
  (409 `invalid_state` once it is reached);
- `AI_PROVIDER=none` makes the harness mount a single "AI is off" agent: the chat says so, and the dashboard still works
  (the route also answers 409 if called anyway);
- providers: Anthropic Messages (production, `claude-sonnet-5-5`, thinking blocks passed back unchanged) or any
  OpenAI-compatible chat-completions endpoint with tools (`AI_PROVIDER=openai`, `AI_BASE_URL`; used in development).

### Run it

```bash
npm install
npm run build -w web
DEMO_MODE=1 npm start          # then open http://localhost:8790/ops/studio and sign in as the arbiter
```

For development: `npm run dev` and `npm run dev:web` (Vite proxies `/api` to the server). The analyst needs an AI provider
(`.env`: `AI_PROVIDER`, `ANTHROPIC_API_KEY` or `AI_BASE_URL` + `AI_API_KEY`).

### Licence

Studio runs unlicensed: a trial banner in the console and an evaluation watermark, all features unlocked. Put the key in
`VITE_AG_STUDIO_LICENSE` (read at build time, applied through `AgStudioProvider`); the studio's own licence covers the AI
module too ("AG Studio Pro with AI"), so request the trial key about Nov 5 (see above) and confirm it includes AI. The key
is a public browser-side string, not a secret. Custom widgets use only Community grid/charts features, as the Studio licence
requires.

### Verified in a real browser

Headless Chromium against a `DEMO_MODE=1` server on a fresh `DATA_DIR`, signed in as the arbiter: the page renders with no
console errors beyond Studio's licence banner; clicking a waterfall step filters the KPI tiles and the other widgets;
the analyst answers "Why did platform net dip last week?" by calling `explain_net_dip` and has the page agent place the
waterfall. Screenshots: `web/docs-screens/real-studio-*.png`.

### Known limits

The Anthropic branch of the relay is covered by unit tests of the message mapping, not a live call (the development setup
only has an OpenAI-compatible proxy). Simulated history is synthetic, generated beside the core rather than by running real
flows, which is why it is flagged on every row.
