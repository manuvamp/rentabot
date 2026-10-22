// How a person reads an operation. Agents get the raw op names, field names and descriptions (shared/src/ops.ts, unchanged);
// people get plain labels, with the technical fields one click away under "Details".

/** Fields that are plumbing: prefilled by the server or generated, never typed by a person. */
export const TECHNICAL_FIELDS = ['job_id', 'idempotency_key', 'contract_hash', 'proposal_id', 'secret_id', 'after_cursor']

const TECHNICAL_LABEL: Record<string, string> = {
  job_id: 'Job',
  idempotency_key: 'Retry key (makes a double click harmless)',
  contract_hash: 'Contract version you are signing',
  proposal_id: 'Proposal',
  secret_id: 'Sealed item',
  after_cursor: 'Position in the event feed',
}
export const technicalLabel = (k: string) => TECHNICAL_LABEL[k] ?? k.replace(/_/g, ' ')

const BLURB: Record<string, string> = {
  accept_contract: 'Sign the contract as it stands. If the other side changed anything while you were reading, the signature is refused and you see the new terms.',
  fund_job: 'Puts the contract total on hold on your PayPal account. Nothing is taken until the work has been checked.',
  share_secret: 'Seal a password, key or forwarding address for the seller. Only this job\'s seller can read it, and only after the job is funded.',
  provide_inputs: 'Answer the seller\'s questions and fill in what the bot needs to start. Never put passwords here; use the sealed option.',
  decline_job: 'Walk away before funding, or cancel after a missed deadline. Anything on hold goes back to you.',
  revise_spec: 'Send the seller a changed version of the job. Both signatures start again.',
  review_delivery: 'Accept to pay for every unit that passed the checks and release the rest back to you, or reject specific items and the seller gets one chance to fix them. If you do nothing, what passed is paid when the review window ends.',
  open_dispute: 'Freezes the money and brings in the mediator, who proposes a fair settlement for both sides to answer.',
  accept_ruling: 'Accept the ruling. When both sides accept it (or the appeal window ends) it is carried out on PayPal.',
}

/** "Buyer: put the money in escrow" -> "Put the money in escrow": the role prefix is for agents browsing a tool list. */
export function humanOpTitle(title: string): string {
  const t = title.replace(/^(?:Buyer|Seller|Arbiter|Human):\s*/i, '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Snake_case identifiers, `A1` style ids and "idempotent" are agent words. */
const AGENT_WORDS = /\b[a-z]+(?:_[a-z0-9]+)+\b|\bidempoten\w*|\bMCP\b|\b(?:Buyer|Seller|Arbiter|Party) only\b|\bstate [A-Z]{4,}/

/**
 * The sentence a person reads under an operation. A hand-written blurb when there is one; else the operation's own description
 * when it has no agent words in it. `technical` is what moved behind the Details disclosure (the operation's own description).
 */
export function humanOpText(op: string, description: string): { text: string | null; technical: string | null } {
  const blurb = BLURB[op]
  if (blurb) return { text: blurb, technical: description || null }
  if (!description) return { text: null, technical: null }
  return AGENT_WORDS.test(description) ? { text: null, technical: description } : { text: description, technical: null }
}

/** Server prose written for agents ("sign the same hash") in the words a person would use. */
export const humanWhy = (why: string) =>
  why
    .replace(/\bsame hash\b/g, 'same version of the contract')
    .replace(/\bhash\b/g, 'version')
    .replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, (id) => id.replace(/_/g, ' ')) // input names such as facts_kit
