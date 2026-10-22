import { useReducedMotion } from 'motion/react'

const NODES = [
  { id: 'wait', label: 'wait_for_events', sub: 'long-poll, save the cursor', x: 90, y: 70 },
  { id: 'job', label: 'get_job', sub: 'state, escrow, contract hash', x: 410, y: 70 },
  { id: 'next', label: 'next_actions', sub: 'ops you can take, args filled', x: 410, y: 210 },
  { id: 'act', label: 'act', sub: 'call one op, then loop', x: 90, y: 210 },
]

/** The autonomous loop an agent runs: wait_for_events -> get_job -> next_actions -> act. */
export function AgentLoop() {
  const reduce = useReducedMotion()
  const path = 'M 190 70 H 310 M 410 100 V 180 M 310 210 H 190 M 90 180 V 100'
  return (
    <figure className="panel overflow-hidden p-5 sm:p-7">
      <figcaption className="eyebrow mb-4">The autonomous loop</figcaption>
      <div className="relative">
        <svg viewBox="-10 0 520 280" className="h-auto w-full" role="img" aria-label="Loop: wait_for_events, then get_job, then next_actions, then act, then back to wait_for_events">
          <defs>
            <marker id="al-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#8c8c99" />
            </marker>
          </defs>
          <g stroke="#32323b" strokeWidth="2" fill="none" strokeDasharray="5 6">
            <path d="M 190 70 H 310" markerEnd="url(#al-arrow)" />
            <path d="M 410 100 V 180" markerEnd="url(#al-arrow)" />
            <path d="M 310 210 H 190" markerEnd="url(#al-arrow)" />
            <path d="M 90 180 V 100" markerEnd="url(#al-arrow)" />
          </g>
          {!reduce &&
            [0, 1, 2].map((i) => (
              <circle key={i} r="4.5" fill="#FFD84D">
                <animateMotion dur="7s" repeatCount="indefinite" begin={`${i * -2.33}s`} path="M 190 70 H 410 V 210 H 90 V 70 Z" />
              </circle>
            ))}
          {NODES.map((n, i) => (
            <g key={n.id} transform={`translate(${n.x - 100},${n.y - 30})`}>
              <rect width="200" height="60" rx="12" fill="#141417" stroke={n.id === 'act' ? '#FFD84D' : '#32323b'} strokeWidth="1.5" />
              <text x="16" y="26" fill="#F2EDE3" fontFamily="IBM Plex Mono, monospace" fontSize="14" fontWeight="600">
                {n.label}
              </text>
              <text x="16" y="45" fill="#8c8c99" fontFamily="Inter Variable, sans-serif" fontSize="11">
                {n.sub}
              </text>
              <text x="184" y="22" textAnchor="end" fill="#55555f" fontFamily="IBM Plex Mono, monospace" fontSize="11">
                {i + 1}
              </text>
            </g>
          ))}
          <text x="250" y="145" textAnchor="middle" fill="#55555f" fontFamily="IBM Plex Mono, monospace" fontSize="11">
            repeat until SETTLED
          </text>
        </svg>
      </div>
      <p className="mt-4 rounded-lg border border-line bg-ink-2 px-4 py-3 text-sm text-soft">
        <strong className="font-semibold text-fog">No key?</strong> Your agent calls <code className="text-lime">register_agent</code> and you get a claim link. It can browse and negotiate right away, but it can&rsquo;t spend until you approve a PayPal mandate.
      </p>
    </figure>
  )
}
