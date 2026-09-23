/**
 * Source-level mutation operators.
 *
 * A hand-written mutation engine rather than Stryker, for one reason: this
 * repository has to mutate Solidity as well as TypeScript, and run each mutant
 * against whichever suite is relevant. One tool that does both, imperfectly and
 * legibly, beats two tools whose reports cannot be compared.
 *
 * The operators are chosen to model mistakes people actually make in exchange
 * code: a comparison the wrong way round, a boundary off by one, a fee applied
 * at the wrong rate, an aggregate that is not maintained. Mutating arbitrary
 * tokens produces a large number of mutants nobody learns anything from.
 */
export interface Mutator {
  readonly id: string
  readonly description: string
  /** Literal source text to find. */
  readonly from: string
  /** What to replace it with. */
  readonly to: string
}

export interface MutantSite {
  readonly file: string
  readonly mutator: Mutator
  readonly line: number
  readonly original: string
  readonly mutated: string
}

/**
 * Operators applied to both languages. Order matters only in that longer
 * patterns are tried first, so `>=` is not mutated as `>` plus a stray `=`.
 */
export const OPERATORS: readonly Mutator[] = [
  { id: 'cmp-gte-gt', description: '>= becomes >', from: '>=', to: '>' },
  { id: 'cmp-lte-lt', description: '<= becomes <', from: '<=', to: '<' },
  { id: 'cmp-gt-gte', description: '> becomes >=', from: '>', to: '>=' },
  { id: 'cmp-lt-lte', description: '< becomes <=', from: '<', to: '<=' },
  { id: 'eq-neq', description: '=== becomes !==', from: '===', to: '!==' },
  { id: 'neq-eq', description: '!== becomes ===', from: '!==', to: '===' },
  { id: 'and-or', description: '&& becomes ||', from: '&&', to: '||' },
  { id: 'or-and', description: '|| becomes &&', from: '||', to: '&&' },
  { id: 'plus-minus', description: '+= becomes -=', from: '+=', to: '-=' },
  { id: 'minus-plus', description: '-= becomes +=', from: '-=', to: '+=' },
]

/** Characters that mean a match is part of a longer operator. */
const GLUE = new Set(['=', '<', '>', '&', '|', '+', '-', '!'])

function isStandalone(line: string, index: number, token: string): boolean {
  const before = line[index - 1]
  const after = line[index + token.length]
  if (before !== undefined && GLUE.has(before)) return false
  if (after !== undefined && GLUE.has(after)) return false
  return true
}

function isSkippable(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed === '' ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  )
}

/**
 * Every mutant that can be made in one file. Comments are excluded, because a
 * mutated comment is guaranteed to survive and would inflate the denominator
 * with cases no test could ever kill.
 */
export function findMutants(file: string, source: string): MutantSite[] {
  const lines = source.split('\n')
  const sites: MutantSite[] = []

  for (const [index, line] of lines.entries()) {
    if (isSkippable(line)) continue

    for (const mutator of OPERATORS) {
      let at = line.indexOf(mutator.from)
      while (at !== -1) {
        if (isStandalone(line, at, mutator.from)) {
          const mutatedLine =
            line.slice(0, at) + mutator.to + line.slice(at + mutator.from.length)
          const mutated = [...lines.slice(0, index), mutatedLine, ...lines.slice(index + 1)].join('\n')
          sites.push({
            file,
            mutator,
            line: index + 1,
            original: line.trim(),
            mutated,
          })
        }
        at = line.indexOf(mutator.from, at + 1)
      }
    }
  }
  return sites
}
