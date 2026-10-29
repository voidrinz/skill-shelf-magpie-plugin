import * as Switch from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

export default function ShelfSwitch({ className = '', ...props }: ComponentProps<typeof Switch.Root>) {
  return <Switch.Root {...props} className={`setting-switch ${className}`} data-slot="switch"><Switch.Thumb /></Switch.Root>;
}
