import { useRef, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from '@/components/ui/dialog';
import en from '@/i18n/messages/en-IN.json';
import ta from '@/i18n/messages/ta-IN.json';

afterEach(() => cleanup());

function Harness() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <div id="root">
    <button ref={trigger} type="button" onClick={() => setOpen(true)}>open</button>
    <Dialog open={open} onClose={() => setOpen(false)} returnFocus={trigger} overlayTestId="receipt-print-preview" panelTestId="receipt-print-dialog" title="Receipt" closeLabel="Close">
      <button type="button">inside-a</button><button type="button">inside-b</button>
    </Dialog>
  </div>;
}

it('receipt print dialog: strings exist in both languages (no raw keys on screen)', () => {
  for (const k of ['common.close', 'sales.print.receiptDialogTitle', 'sales.print.receiptAction']) {
    expect((en as Record<string, string>)[k], `en ${k}`).toBeTruthy();
    expect((ta as Record<string, string>)[k], `ta ${k}`).toBeTruthy();
  }
});

it('receipt print dialog: opens as a <body> child, focus goes inside, Tab stays inside, Esc closes and focus returns to the trigger', () => {
  render(<Harness />);
  const trigger = screen.getByText('open');
  trigger.focus();
  fireEvent.click(trigger);
  const overlay = screen.getByTestId('receipt-print-preview');
  expect(overlay.parentElement).toBe(document.body);
  const panel = screen.getByTestId('receipt-print-dialog');
  expect(panel.getAttribute('role')).toBe('dialog');
  expect(panel.getAttribute('aria-modal')).toBe('true');
  expect(document.activeElement).toBe(panel);
  const last = screen.getByTestId('dialog-close');
  last.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(panel.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByTestId('receipt-print-preview')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('receipt print dialog: close button and backdrop click close it and return focus', () => {
  render(<Harness />);
  const trigger = screen.getByText('open');
  trigger.focus(); fireEvent.click(trigger);
  fireEvent.click(screen.getByTestId('dialog-close'));
  expect(screen.queryByTestId('receipt-print-preview')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.mouseDown(screen.getByTestId('receipt-print-preview'));
  expect(screen.queryByTestId('receipt-print-preview')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
