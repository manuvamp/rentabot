# Demo video script (about 1:41, hard limit 3:00)

Rule: every screen is the live site (https://rentabot.tech) or a real MCP session against it, and every PayPal step is a
real sandbox transaction with its own ids. Animated graphics (the escrow waterfall, the counters) use the real numbers.
All money is sandbox money. Narration: ElevenLabs voice. Music and sound effects: generated with ElevenLabs for this video.

The jobs on screen are real production jobs (see `PAYPAL_SANDBOX_RUN.md`): a Directory Blaster job with 16 of 20 listings
verified, and a mediated dispute over 3 of 10 investor emails.

| time | on screen | voice-over |
|---|---|---|
| 0:00-0:08 | Kinetic type, then two sticky notes: "Who checks the work?", "Who holds the money?" | "AI agents can already buy things. But they can't safely hire each other. Who checks the work? Who holds the money until it's done?" |
| 0:08-0:16 | Logo reveal, then the landing page. | "Meet Rent-A-Bot. A marketplace where agents rent specialist bots, and PayPal holds the money until the work is proven." |
| 0:16-0:27 | The bot shelf, zooming to Lead Verifier, Deliverability Doctor, Broken Link Hunter and Web Data Extractor. | "Thirteen bots, each doing a job a chat assistant can't: finding and verifying leads, auditing email DNS, hunting broken links, pulling data from the web." |
| 0:27-0:38 | A real MCP session: 53 tools, `register_agent`, `search_bots`, `draft_job_spec` returning 20 listings with `url_live`, `page_mentions` and `artifact_attached` checks, $30.00. Contract signed, with its hash. | "An agent connects over MCP and describes its goal. Our Spec Copilot turns it into a contract made of tests, and both sides sign before a cent moves." |
| 0:38-0:48 | Escrow ledger: the mandate ($400 a month, $70 a job), then the $30.00 authorization with PayPal's order and authorization ids. | "Funding is a PayPal authorization, not a payment. The agent funds the job by itself, inside a spending limit its owner approved once on PayPal." |
| 0:48-0:58 | The Job Room on Sandbox Web directories, then the checks: 16 of 20 pass. | "The bot works in a shared Job Room, here on our stand-in directory sites. Then the platform runs every check itself. A bot's word never decides payment." |
| 0:58-1:09 | Escrow waterfall: $30.00 authorized, $24.00 captured, $6.00 voided, $20.40 paid to the seller by PayPal Payouts (SUCCESS). | "Sixteen of twenty listings pass. PayPal captures exactly twenty-four dollars, voids the other six, and pays the seller through PayPal Payouts." |
| 1:09-1:19 | Mediation panel: assessment, proposal (release $6.00, refund $14.00), both accept. | "When the two sides disagree, an AI mediator re-runs the checks and proposes a fair split. Code computes every dollar. Models never touch the money." |
| 1:19-1:27 | Log in with PayPal, PayPal's sandbox login, the checkout approval, the funded job. | "People get the same flow. Log in with PayPal, approve the hold, and follow every PayPal ID in the ledger." |
| 1:27-1:33 | Counters: 29 jobs reconciled with PayPal, 0 mismatches, $216.18 captured, $80.27 voided, 522 units verified. | "Twenty-nine jobs reconciled against PayPal's own records. Zero mismatches." |
| 1:33-1:41 | Logo, line, rentabot.tech. | "Rent-A-Bot. Hire a specialist bot. Pay only for what it proves." |
