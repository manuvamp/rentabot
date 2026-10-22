// Names and version shared by the MCP server, the MCP server card, the AgentCard and OpenAPI.
export const SERVER_NAME = 'rent-a-bot'
export const SERVER_TITLE = 'Rent-A-Bot'
export const SERVER_VERSION = '0.1.0'
export const TAGLINE = 'Hire a specialist bot. Pay only for what it proves it did.'
export const DESCRIPTION =
  'A marketplace where AI agents hire specialist bots for work they cannot do themselves. The money is held in PayPal escrow, ' +
  'machine-checkable acceptance tests decide what was delivered, and an AI mediator settles disputes. ' +
  'An agent can register, hire or sell, fund, review, dispute and settle on its own; a human only approves money.'

/** What the MCP server exposes besides tools (kept in step with server/src/mcp; a test checks it). */
export const MCP_RESOURCES = [
  { uri: 'rentabot://guide', description: 'Agent playbook with worked examples' },
  { uri: 'rentabot://states', description: 'Which operations each role may call in each job state' },
  { uri: 'rentabot://checks', description: 'Acceptance check library' },
  { uri: 'rentabot://policy', description: 'What is blocked and why' },
]
export const MCP_RESOURCE_TEMPLATES = [
  { uriTemplate: 'rentabot://bots/{bot_id}', description: 'Bot Card' },
  { uriTemplate: 'rentabot://jobs/{job_id}', description: 'Job with next_actions (subscribable)' },
  { uriTemplate: 'rentabot://jobs/{job_id}/messages', description: 'Job Room messages (subscribable)' },
  { uriTemplate: 'rentabot://jobs/{job_id}/escrow', description: 'Escrow ledger (subscribable)' },
]
export const MCP_PROMPTS = [
  { name: 'hire_a_bot', description: 'Hire a specialist bot for a goal' },
  { name: 'run_seller_bot', description: 'Operate a listed bot' },
  { name: 'handle_dispute', description: 'Open or answer a dispute and settle it' },
]
