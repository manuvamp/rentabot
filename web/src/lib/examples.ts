// Example jobs for the landing page: the hero's rotating placeholder and the two-row marquee.
// Every line is something one of the house bots really does (see server/src/seed/bots.ts); `bot` is the bot's name, matched at runtime.
export type ExampleIcon = 'globe' | 'send' | 'shield' | 'scan' | 'mail'

export interface ExampleJob {
  bot: string
  category: string
  icon: ExampleIcon
  text: string
}

export const EXAMPLES: ExampleJob[] = [
  { bot: 'Directory Blaster', category: 'Directories', icon: 'globe', text: 'Get ORANO listed on 40 AI directories before launch' },
  { bot: 'Investor Outreach Bot', category: 'Outreach', icon: 'send', text: 'Email 60 seed investors who back developer tools' },
  { bot: 'Agent-Readiness Auditor', category: 'Audit', icon: 'scan', text: 'Audit my docs: can an AI agent actually use them?' },
  { bot: 'Lead Verifier', category: 'Lead data', icon: 'shield', text: 'Check that every email in my 200-lead list is real' },
  { bot: 'Cold Email Writer', category: 'Copy', icon: 'mail', text: 'Write 30 cold emails that pass the linter' },
  { bot: 'Directory Blaster', category: 'Directories', icon: 'globe', text: 'Submit my MCP server to every MCP registry' },
  { bot: 'Investor Outreach Bot', category: 'Outreach', icon: 'send', text: 'Reach 30 angels who wrote about AI agents' },
  { bot: 'Lead Verifier', category: 'Lead data', icon: 'shield', text: 'Drop the leads whose email is not on the company site' },
  { bot: 'Agent-Readiness Auditor', category: 'Audit', icon: 'scan', text: 'Prove which claims about my site an agent can verify' },
  { bot: 'Cold Email Writer', category: 'Copy', icon: 'mail', text: 'Personalize 20 intro emails from my facts sheet' },
  { bot: 'Directory Blaster', category: 'Directories', icon: 'globe', text: 'List my SaaS on 60 startup directories, with screenshots' },
  { bot: 'Lead Verifier', category: 'Lead data', icon: 'shield', text: 'Re-check last quarter’s lead list before we send' },
]

/** The first five (one per bot) rotate as the hero placeholder. */
export const PLACEHOLDERS = EXAMPLES.slice(0, 5).map((e) => (/[.?!]$/.test(e.text) ? e.text : `${e.text}.`))
