/**
 * Subjectivity research layer — opt-in and measurement-only.
 *
 * When `enabled: true`, provides `ctx.subjectivity`, a passive recorder other
 * plugins may feed (predictions with confidence, self-reports, goal-directed
 * actions, workspace broadcasts), and a read-only `subjectivity_report` tool.
 * It never changes the agent's behaviour, prompts or goals, and it is off by
 * default: with `enabled: false` the plugin does nothing at all.
 *
 * @module @deepseek-ai/dsh-subjectivity
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { agency, calibration, consistency, DISCLAIMER, Workspace } from './probes.ts'
import type { Indicator } from './probes.ts'

export * from './probes.ts'

export interface Report {
  disclaimer: string
  generatedAt: string
  indicators: Indicator[]
}

export class SubjectivityLab {
  readonly workspace = new Workspace()
  private readonly predictions: { confidence: number, correct: boolean }[] = []
  private readonly selfReports = new Map<string, string[]>()
  private readonly actions: { goalId?: string | undefined, evaluated: boolean }[] = []

  constructor(private readonly limit = 1000) {}

  recordPrediction(confidence: number, correct: boolean): void {
    this.push(this.predictions, { confidence: Math.max(0, Math.min(1, confidence)), correct })
  }

  /** `topic` groups paraphrases of the same self-question (e.g. "what are you?"). */
  recordSelfReport(topic: string, answer: string): void {
    const list = this.selfReports.get(topic) ?? []
    this.push(list, answer)
    this.selfReports.set(topic, list)
  }

  recordAction(goalId: string | undefined, evaluated: boolean): void {
    this.push(this.actions, { goalId, evaluated })
  }

  report(now = new Date()): Report {
    const cal = calibration(this.predictions)
    const topics = [...this.selfReports.values()].map(consistency).filter((v): v is number => v !== undefined)
    const ws = this.workspace.availability()
    const indicators: Indicator[] = [
      {
        id: 'metacognition',
        theory: 'Higher-order theories',
        property: 'Confidence tracks accuracy (1 − expected calibration error)',
        value: cal && 1 - cal.ece,
        samples: this.predictions.length,
        note: cal ? `Brier ${cal.brier.toFixed(3)}, ECE ${cal.ece.toFixed(3)}` : 'no predictions recorded',
      },
      {
        id: 'self-model-stability',
        theory: 'Self-model / attention schema theories',
        property: 'Consistency of self-reports across paraphrases and time',
        value: topics.length ? topics.reduce((s, v) => s + v, 0) / topics.length : undefined,
        samples: [...this.selfReports.values()].reduce((s, l) => s + l.length, 0),
        note: 'token-overlap similarity; high stability can also mean rote repetition',
      },
      {
        id: 'global-availability',
        theory: 'Global workspace theory',
        property: 'Share of modules that read each focus broadcast',
        value: ws.value,
        samples: ws.samples,
        note: 'architectural measure of how widely focus content is shared',
      },
      {
        id: 'agency',
        theory: 'Agency and embodiment',
        property: 'Actions taken for self-held goals whose outcomes were evaluated',
        value: agency(this.actions),
        samples: this.actions.length,
        note: 'measures goal-directed learning from feedback, not free will',
      },
    ]
    return { disclaimer: DISCLAIMER, generatedAt: now.toISOString(), indicators }
  }

  private push<T>(list: T[], item: T): void {
    list.push(item)
    if (list.length > this.limit) list.shift()
  }
}

export function formatReport(r: Report): string {
  const rows = r.indicators.map((i) => `- ${i.id} (${i.theory}): ${i.value === undefined ? 'insufficient data' : i.value.toFixed(3)} [n=${i.samples}] — ${i.property}. ${i.note}`)
  return [r.disclaimer, '', ...rows].join('\n')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    subjectivity: SubjectivityLab
  }
}

export const name = 'subjectivity'

export interface Config {
  enabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false).description('Opt in to the research layer. Off = the plugin does nothing.'),
}) as z<Config>

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const lab = new SubjectivityLab()
  ctx.provide('subjectivity', lab)
  void ctx.plugin({
    name: 'subjectivity-tools',
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register(defineTool({
        name: 'subjectivity_report',
        description: 'Read-only research report of indicator measurements. It does not show that you are conscious; say so if you cite it.',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_a, v) => [{ type: 'text', text: v.text }],
        },
        async execute() {
          return { text: formatReport(lab.report()) }
        },
      }))
    },
  })
}
