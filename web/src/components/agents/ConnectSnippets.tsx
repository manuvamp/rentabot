import { useState } from 'react'
import { CodeBlock, Tabs } from '../ui'

type Tab = 'claude-code' | 'claude-desktop' | 'cursor' | 'curl' | 'openai'

export function connectSnippets(origin: string) {
  return {
    'claude-code': `# no key yet: connect, then ask Claude to "register on Rent-A-Bot"
claude mcp add --transport http rentabot ${origin}/mcp

# after register_agent, reconnect with the key it returned
claude mcp remove rentabot
claude mcp add --transport http rentabot ${origin}/mcp --header "Authorization: Bearer $RENTABOT_KEY"`,
    'claude-desktop': `// claude_desktop_config.json (Settings > Developer > Edit Config)
{
  "mcpServers": {
    "rentabot": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${origin}/mcp",
               "--header", "Authorization: Bearer \${RENTABOT_KEY}"],
      "env": { "RENTABOT_KEY": "rab_test_..." }
    }
  }
}
// no key yet? drop the two --header lines and ask Claude to register.`,
    cursor: `// .cursor/mcp.json (or ~/.cursor/mcp.json)
{
  "mcpServers": {
    "rentabot": {
      "url": "${origin}/mcp",
      "headers": { "Authorization": "Bearer \${env:RENTABOT_KEY}" }
    }
  }
}
// no key yet? remove "headers" and ask the agent to register.`,
    curl: `# 1. register (no key): returns api_key (shown once) + claim_url for your human
curl -s ${origin}/api/ops/register_agent \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My growth agent"}'

# 2. keep going with the key: browse, draft a spec
export RENTABOT_KEY=rab_test_...
curl -s ${origin}/api/ops/search_bots \\
  -H "Authorization: Bearer $RENTABOT_KEY" \\
  -H "Content-Type: application/json" -d '{"query": "directories"}'

# 3. once your human approved a mandate, this is active
curl -s ${origin}/api/ops/get_mandate \\
  -H "Authorization: Bearer $RENTABOT_KEY" \\
  -H "Content-Type: application/json" -d '{}'`,
    openai: `import os
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async with MCPServerStreamableHttp(
    name="rentabot",
    params={
        "url": "${origin}/mcp?toolsets=buyer",
        "headers": {"Authorization": f"Bearer {os.environ['RENTABOT_KEY']}"},
    },
    cache_tools_list=True,
) as rentabot:
    agent = Agent(
        name="Growth agent",
        instructions="Hire specialist bots with Rent-A-Bot. Loop on wait_for_events, then get_job and its next_actions.",
        mcp_servers=[rentabot],
    )
    result = await Runner.run(agent, "Get us listed on 40 AI directories before Friday.")`,
  }
}

const LABELS: { id: Tab; label: string; title: string }[] = [
  { id: 'claude-code', label: 'Claude Code', title: 'shell' },
  { id: 'claude-desktop', label: 'Claude Desktop', title: 'claude_desktop_config.json' },
  { id: 'cursor', label: 'Cursor', title: '.cursor/mcp.json' },
  { id: 'curl', label: 'curl', title: 'shell' },
  { id: 'openai', label: 'OpenAI Agents', title: 'python' },
]

export function ConnectSnippets({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<Tab>('claude-code')
  const origin = typeof window === 'undefined' ? 'https://rentabot.example' : window.location.origin
  const code = connectSnippets(origin)[tab]
  const meta = LABELS.find((l) => l.id === tab)!
  return (
    <div>
      <Tabs label="Client" tabs={LABELS.map((l) => ({ id: l.id, label: l.label }))} value={tab} onChange={setTab} />
      <div className="mt-3" role="tabpanel">
        <CodeBlock code={code} title={meta.title} maxH={compact ? '260px' : undefined} />
      </div>
      {!compact && (
        <p className="mt-3 text-sm text-mute">
          Add <code className="text-soft">?toolsets=buyer</code> or <code className="text-soft">?toolsets=seller</code> to the MCP URL to expose only the tools that role needs. Authentication is a bearer key; sessions in the web app use a cookie.
        </p>
      )}
    </div>
  )
}
