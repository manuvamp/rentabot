// Negotiation-first mediation (docs/MEDIATION.md v2, T2 steps 2-4): the schemas of job.mediation.
// They live in @rentabot/shared (shared/src/mediation.ts) so the server, the web app and agents agree on them;
// this module re-exports them so the negotiator and its tests keep their local imports.
export {
  MAX_ROUNDS,
  MAX_HOLD_DAYS,
  Party,
  Redo,
  ProposalTerms,
  CounterTerms,
  ProposalKind,
  ResponseAnswer,
  ProposalResponse,
  ProposalStatus,
  SettlementPreview,
  Proposal,
  IntegrityFlag,
  Assessment,
  MediationStatus,
  MediationState,
} from '@rentabot/shared'
