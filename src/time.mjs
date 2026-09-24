// Timing helpers, kept pure so they're trivially reusable and testable.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Randomize a wait by ±jitter (0..1) so requests don't arrive on an exact
// metronome — a common bot-detection trigger.
export const withJitter = (ms, jitter = 0) => Math.round(ms * (1 + (Math.random() * 2 - 1) * jitter));
