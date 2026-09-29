/** Decorative occupant for the Autonomy sidebar entry. */
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the sparkle glyph at the size the sidebar asks for; the sidebar owns
 * the accessible navigation label.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function AutonomyIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconSparkleRegular size={size} />
}
