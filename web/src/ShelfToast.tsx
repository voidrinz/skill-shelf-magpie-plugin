import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import './shelf-toast.css';

type ToastTone = 'error' | 'info' | 'success' | 'warning';
type ToastOptions = { duration?: number; title?: ReactNode };
type ToastEntry = ToastOptions & { description: ReactNode; id: number; tone: ToastTone };

let nextToastId = 0;
const listeners = new Set<(entry: ToastEntry) => void>();

function addToast(tone: ToastTone, description: ReactNode, options?: ToastOptions) {
  const entry = { description, id: ++nextToastId, tone, ...options };
  listeners.forEach(listener => listener(entry));
  return entry.id;
}

export const toast = {
  error: (description: ReactNode, options?: ToastOptions) => addToast('error', description, options),
  info: (description: ReactNode, options?: ToastOptions) => addToast('info', description, options),
  success: (description: ReactNode, options?: ToastOptions) => addToast('success', description, options),
  warning: (description: ReactNode, options?: ToastOptions) => addToast('warning', description, options),
};

export function Toaster() {
  const [items, setItems] = useState<ToastEntry[]>([]);
  useEffect(() => {
    const listener = (entry: ToastEntry) => {
      setItems(current => [...current, entry].slice(-3));
      window.setTimeout(() => {
        setItems(current => current.filter(item => item.id !== entry.id));
      }, entry.duration ?? 4000);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  return <div data-slot="toaster" className="shelf-toaster" role="region" aria-label="通知" aria-live="polite" aria-relevant="additions" onPointerDown={event => event.stopPropagation()}>
    {items.map(item => {
      const Icon = item.tone === 'success' ? CircleCheck : item.tone === 'error' ? CircleX : item.tone === 'warning' ? TriangleAlert : Info;
      return <div className="shelf-toast" key={item.id} role={item.tone === 'error' ? 'alert' : 'status'}>
        <span className="shelf-toast-icon" data-tone={item.tone}><Icon size={14} /></span>
        <div className="shelf-toast-content">
          {item.title && <strong>{item.title}</strong>}
          <div className={item.title ? 'shelf-toast-description' : undefined}>{item.description}</div>
        </div>
        <button className="shelf-toast-dismiss" aria-label="关闭通知" type="button" onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}><X size={14} /></button>
      </div>;
    })}
  </div>;
}
