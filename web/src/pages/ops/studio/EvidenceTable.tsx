// What opens under an `explain_net_dip` call in the Studio chat panel: the ranked drivers and the jobs behind each one.
import type { AgAiToolDetailParams } from 'ag-studio'
import type { NetExplanation } from './analysis'

const usd = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toFixed(2)}`
const plain = (x: number) => `$${x.toFixed(2)}`
const tone = (x: number) => (x < -0.004 ? 'neg' : x > 0.004 ? 'pos' : '')

export function EvidenceTable(p: AgAiToolDetailParams) {
  if (p.status !== 'done' && p.status !== 'cancelled') return <div className="rab-w-note">Working through the ledger...</div>
  if (!p.result) return <div className="rab-w-note">The call was cancelled.</div>
  if (!p.result.success) return <div className="rab-w-note">{p.result.issues.map((i) => i.message).join(' ')}</div>
  const d = p.result.data as NetExplanation | undefined
  if (!d) return null
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="rab-w-note">
        {d.period.label} ({d.period.from} to {d.period.to}): net {plain(d.net_period)} against {plain(d.net_baseline_avg)} average over the {d.baseline.periods} period(s) before. Change{' '}
        <span className={tone(d.delta)}>{usd(d.delta)}</span>.
      </div>
      <table className="rab-evidence">
        <thead>
          <tr>
            <th>Driver</th>
            <th className="num">Impact</th>
            <th className="num">Jobs</th>
          </tr>
        </thead>
        <tbody>
          {d.drivers.map((x) => (
            <tr key={x.driver}>
              <td>{x.label}</td>
              <td className={`num ${tone(x.impact_usd)}`}>{usd(x.impact_usd)}</td>
              <td className="num">{x.jobs}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.drivers
        .filter((x) => x.evidence.length > 0)
        .slice(0, 3)
        .map((x) => (
          <table className="rab-evidence" key={x.driver}>
            <thead>
              <tr>
                <th colSpan={3}>{x.label}: the jobs behind it</th>
              </tr>
            </thead>
            <tbody>
              {x.evidence.map((e) => (
                <tr key={e.job_id}>
                  <td>
                    {e.date}
                    <br />
                    {e.bot}
                  </td>
                  <td>{e.detail}</td>
                  <td className={`num ${tone(e.platform_net)}`}>{usd(e.platform_net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  )
}
