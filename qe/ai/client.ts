/**
 * Shared Anthropic client, model choices and a spend guard.
 *
 * Two models, chosen per job rather than by default:
 *
 * - Sonnet 5 writes tests. Test generation is the part where a weaker model
 *   produces plausible-looking assertions that check nothing, which costs more
 *   to review than the tests save.
 * - Haiku 4.5 classifies failures. Triage is high volume, the taxonomy is
 *   small, and the answer is graded against labels, so a cheaper model is the
 *   right call and the scoring proves whether it was.
 *
 * Opus is deliberately not used. It is several times the price and there is no
 * evidence in this repository that it would do either job better, which is the
 * only argument that should buy a more expensive model.
 *
 * Every run prints an estimated cost before it starts and refuses to exceed
 * MAX_SPEND_USD without an explicit override. A tool that can quietly spend
 * money in a loop is a tool that eventually does.
 */
import Anthropic from '@anthropic-ai/sdk'

export const MODELS = {
  /** Test generation and root-cause narrative. */
  author: 'claude-sonnet-5',
  /** High-volume classification. */
  classifier: 'claude-haiku-4-5',
} as const

/** USD per million tokens, from the published pricing table. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

export const MAX_SPEND_USD = Number(process.env.AI_MAX_SPEND_USD ?? 0.25)

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model]
  if (price === undefined) throw new Error(`no pricing for ${model}`)
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output
}

export function createClient(): Anthropic {
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. On this machine the key lives in the ' +
        'Keychain, so run these through the secrun wrapper:\n' +
        '  secrun npm run ai:generate',
    )
  }
  return new Anthropic()
}

/** Running total for one process, so a loop cannot overspend unnoticed. */
export class SpendTracker {
  #spent = 0
  readonly #limit: number

  constructor(limit = MAX_SPEND_USD) {
    this.#limit = limit
  }

  get spent(): number {
    return this.#spent
  }

  /**
   * Refuse a call before it is made if its worst case would break the limit.
   *
   * `record` alone only notices afterwards. One test-generation call with a
   * 32,000-token output budget can cost $0.32 on its own, so a guard that
   * checks after the call lets the first call blow straight through a $0.25
   * limit and then complains about it.
   */
  ensureRoom(model: string, inputTokens: number, maxOutputTokens: number): void {
    const worstCase = this.#spent + estimateCost(model, inputTokens, maxOutputTokens)
    if (worstCase > this.#limit) {
      throw new Error(
        `spend guard: this call could bring the run to $${worstCase.toFixed(4)}, over the ` +
          `$${this.#limit.toFixed(2)} limit, so it was not sent. Raise AI_MAX_SPEND_USD ` +
          'deliberately if this run is meant to cost more.',
      )
    }
  }

  record(model: string, usage: { input_tokens: number; output_tokens: number }): void {
    this.#spent += estimateCost(model, usage.input_tokens, usage.output_tokens)
    if (this.#spent > this.#limit) {
      throw new Error(
        `spend guard tripped: $${this.#spent.toFixed(4)} exceeds the $${this.#limit.toFixed(2)} limit. ` +
          'Raise AI_MAX_SPEND_USD deliberately if this run is meant to cost more.',
      )
    }
  }

  summary(): string {
    return `estimated spend: $${this.#spent.toFixed(4)} of $${this.#limit.toFixed(2)}`
  }
}

/**
 * Count tokens before sending, so the estimate printed to the user comes from
 * the API rather than from a guess at four characters per token.
 */
export async function countInputTokens(
  client: Anthropic,
  model: string,
  system: string,
  content: string,
): Promise<number> {
  const result = await client.messages.countTokens({
    model,
    system,
    messages: [{ role: 'user', content }],
  })
  return result.input_tokens
}
