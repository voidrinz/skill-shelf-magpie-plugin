import * as Tooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

export const TooltipProvider = Tooltip.Provider;

export default function ShelfTooltip({ children, content, className = '' }: { children: ReactNode; content: ReactNode; className?: string }) {
  return <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal>
    <Tooltip.Content className={`shelf-tooltip ${className}`} side="top" sideOffset={6}>
      {content}<Tooltip.Arrow className="shelf-tooltip-arrow" />
    </Tooltip.Content>
  </Tooltip.Portal></Tooltip.Root>;
}
