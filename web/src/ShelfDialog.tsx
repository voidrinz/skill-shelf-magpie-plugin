import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, type ComponentProps } from 'react';
import { preserveSearchOnEscape } from './SearchField';

export function DialogTitle(props: ComponentProps<typeof Dialog.Title>) {
  return <Dialog.Title {...props} data-slot="dialog-title" />;
}
export function DialogDescription(props: ComponentProps<typeof Dialog.Description>) {
  return <Dialog.Description {...props} data-slot="dialog-description" />;
}

export default function ShelfDialog({ children, className = '', closeLabel = '关闭', locked = false, onClose, returnFocus, ...props }: ComponentProps<typeof Dialog.Content> & {
  closeLabel?: string;
  locked?: boolean;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const previous = useRef(document.activeElement as HTMLElement | null);
  return <Dialog.Root open onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="shelf-dialog-overlay" data-slot="dialog-overlay" />
      <Dialog.Content {...props} className={`shelf-dialog ${className}`} data-slot="dialog-content" aria-modal="true"
        onEscapeKeyDown={event => {
          if (locked) event.preventDefault();
          preserveSearchOnEscape(event);
          props.onEscapeKeyDown?.(event);
        }}
        onInteractOutside={event => {
          if (locked) event.preventDefault();
          props.onInteractOutside?.(event);
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          (returnFocus ?? previous.current)?.focus();
          props.onCloseAutoFocus?.(event);
        }}>
        {children}
        <Dialog.Close className="shelf-dialog-close" aria-label={closeLabel} disabled={locked}><X /></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
