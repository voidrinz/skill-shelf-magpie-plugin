import { Slot } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';

type ButtonSize = 'default' | 'md' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-lg';
type ButtonVariant = 'default' | 'primary' | 'destructive' | 'danger' | 'outline' | 'secondary' | 'ghost' | 'link';

// Mirrors the desktop Button primitive without its Tailwind runtime dependency.
export default function ShelfButton({ asChild = false, size = 'default', variant = 'default', type = 'button', className = '', ...props }: ComponentProps<'button'> & { asChild?: boolean; size?: ButtonSize; variant?: ButtonVariant }) {
  const Component = asChild ? Slot : 'button';
  return <Component {...props} type={asChild ? undefined : type} data-slot="button" data-size={size} data-variant={variant} className={`shelf-button shelf-button-size-${size} shelf-button-variant-${variant} ${className}`} />;
}
