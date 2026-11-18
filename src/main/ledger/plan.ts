import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Plan } from '../../shared/types'

export const PLAN_TOOL = 'mcp__code-hole__submit_plan'

export const PLAN_PROMPT = `Code Hole measures plan vs. execution. Before editing code for any change that touches more than one file or adds, removes, or merges a function, class, type, or module, call ${PLAN_TOOL} once with the primitives you will create, extend, delete, or combine. Name real symbols (exported names, or Class.member) and repo-relative files. Don't resubmit to match what you did — deviations are reported back to you at the end for a one-line explanation each. Don't commit or push during a planned change: Code Hole moves it onto a feature branch, commits with the plan as trailers, pushes the branch and opens the PR.`

const item = z.object({
  id: z.string().describe('Short stable id, e.g. "p1"'),
  action: z.enum(['create', 'extend', 'delete', 'combine']),
  primitive: z.string().describe('The module, function, class, or type this item is about'),
  files: z.array(z.string()).describe('Repo-relative paths this item will touch'),
  symbols: z.array(z.string()).describe('Symbols to add/change/remove: exported names or Class.member'),
  from: z.array(z.string()).optional().describe('combine only: the symbols being merged into `symbols`'),
  why: z.string(),
})

export function planServer(onPlan: (plan: Plan) => Promise<string>) {
  return createSdkMcpServer({
    name: 'code-hole',
    tools: [
      tool(
        'submit_plan',
        'Declare the primitives this change will create, extend, delete, or combine. Code Hole renders them and verifies the diff against them.',
        { goal: z.string(), items: z.array(item).min(1) },
        async (args) => ({ content: [{ type: 'text', text: await onPlan(args as Plan) }] }),
      ),
    ],
  })
}
