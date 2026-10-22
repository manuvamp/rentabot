import { Check, ClipboardCheck, Cpu, Film, GitPullRequest, Send, ShieldCheck, Users, type LucideIcon } from 'lucide-react'
import type { CapabilityClass } from '../../api/types'
import { botSlug } from '../../lib/botArt'
import { AccountSetupScene, ApplicationScene, AuditScene, DirectoryScene, LeadsScene, OutreachScene, WriterScene, type SceneProps } from './scenes'
import { LandingScene, RedTeamScene } from './newbots-scenes'
import { DoctorScene, ExtractorScene, LinkHunterScene } from './web-scenes'
import { MOVE, pop, useLoop } from './useLoop'

const BY_BOT: Record<string, (p: SceneProps) => React.ReactElement> = {
  'directory-blaster': DirectoryScene,
  'investor-outreach': OutreachScene,
  'lead-verifier': (p) => <LeadsScene {...p} />,
  'lead-verifier-budget': (p) => <LeadsScene {...p} budget />,
  'budget-lead-verifier': (p) => <LeadsScene {...p} budget />,
  'agent-readiness-auditor': AuditScene,
  'cold-email-writer': WriterScene,
  'landing-page-bot': LandingScene,
  'agent-red-team': RedTeamScene,
  'deliverability-doctor': DoctorScene,
  'broken-link-hunter': LinkHunterScene,
  'web-data-extractor': ExtractorScene,
  'account-setup': AccountSetupScene,
  'application-filler': ApplicationScene,
}

/** The function loop for a bot: its own scene when it has one, otherwise a generic scene for its capability class. */
export function BotLoop({ name, cls, dark }: { name: string; cls: CapabilityClass; dark?: boolean }) {
  const Scene = BY_BOT[botSlug(name)]
  return Scene ? <Scene dark={dark} /> : <GenericScene cls={cls} dark={dark} />
}

const GENERIC: Record<CapabilityClass, [LucideIcon, string, string]> = {
  real_world_action: [ClipboardCheck, 'form', 'submitted'],
  reach: [Send, 'message', 'delivered'],
  compute_media: [Film, 'render', 'rendered'],
  open_weights: [Cpu, 'run', 'done locally'],
  security: [ShieldCheck, 'attack', 'replayed'],
  human_in_loop: [Users, 'task', 'done by a person'],
  code: [GitPullRequest, 'test', 'green'],
}

function GenericScene({ cls, dark }: { cls: CapabilityClass; dark?: boolean }) {
  const [Icon, unit, verb] = GENERIC[cls] ?? GENERIC.real_world_action
  const { ref, step } = useLoop(5, 700)
  return (
    <div ref={ref} className="absolute inset-0 px-3 pb-6 pt-10" aria-hidden>
      <ul className="space-y-1.5">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="flex h-[19px] items-center gap-1.5 rounded-md bg-[#fbf8f1] px-1.5 text-ink shadow-[0_3px_6px_-3px_rgba(0,0,0,0.45)]">
            <Icon className="size-3 shrink-0" aria-hidden />
            <span className="w-12 shrink-0 font-mono text-[9.5px]">{unit} {i + 1}</span>
            <span className="relative h-1.5 flex-1 overflow-hidden rounded bg-ink/10">
              <span className="absolute inset-0 origin-left rounded bg-ink/70 transition-transform duration-700 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${step > i ? 1 : 0})` }} />
            </span>
            <span className={`${MOVE} grid size-3.5 place-items-center rounded-full bg-mint-deep text-white`} style={pop(step > i)}>
              <Check className="size-2.5" strokeWidth={3.5} />
            </span>
          </li>
        ))}
      </ul>
      <span className={`absolute bottom-2 left-3 rounded px-1.5 py-px font-mono text-[10.5px] font-bold ${dark ? 'bg-fog text-ink' : 'bg-ink text-hl'}`}>
        {Math.min(step, 4)}/4 {verb}
      </span>
    </div>
  )
}
