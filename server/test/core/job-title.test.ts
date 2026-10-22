// create_job takes an optional title; a blank one falls back to the goal (it used to create a job with an empty title).
import { afterEach, describe, expect, it } from 'vitest'
import { directorySpec, harness, type Harness } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.close()
})

const create = (title: string | undefined, key: string) => h.call('create_job', h.buyer, { bot_id: h.bots['Directory Blaster'], spec: directorySpec(4), ...(title === undefined ? {} : { title }), idempotency_key: key })

describe('create_job title', () => {
  it('uses the title the buyer gave, trimmed', async () => {
    h = await harness()
    expect((await create('  Launch week listings  ', 'title-key-1')).job.title).toBe('Launch week listings')
  })

  it('falls back to the goal when the title is missing or blank', async () => {
    h = await harness()
    const goal = directorySpec(4).goal
    expect((await create(undefined, 'title-key-2')).job.title).toBe(goal.slice(0, 140))
    expect((await create('   ', 'title-key-3')).job.title).toBe(goal.slice(0, 140))
  })
})
