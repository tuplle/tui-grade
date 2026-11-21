/** Control characters (C0, DEL, C1) in a single-line message. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Replaces control characters with `?`. Strings that come from students (file names, entry names) end up in warnings,
 * terminal output and reports; an ESC sequence in them must never reach the teacher's terminal.
 */
export const stripControl = (s: string): string => s.replace(CONTROL, '?');
