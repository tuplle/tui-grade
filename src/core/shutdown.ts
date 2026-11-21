// Set once the grader is being stopped (Ctrl-C / SIGTERM): nothing new may be started, created or written after that.
export type StopSignal = 'SIGINT' | 'SIGTERM';

let stopping = false;
let stopSignal: StopSignal = 'SIGINT';

export const beginShutdown = (signal: StopSignal = 'SIGINT'): void => {
  stopping = true;
  stopSignal = signal;
};

export const isShuttingDown = (): boolean => stopping;

/** Exit code of the signal that started the shutdown: 128 + signal number (130 for SIGINT, the default; 143 for SIGTERM). */
export const shutdownExitCode = (): number => (stopSignal === 'SIGTERM' ? 143 : 130);

/** Test-only: sets or clears the flag (tests reset it in `afterEach`); clearing also resets the signal to SIGINT. */
export const __setShuttingDown = (value: boolean, signal: StopSignal = 'SIGINT'): void => {
  stopping = value;
  stopSignal = value ? signal : 'SIGINT';
};
