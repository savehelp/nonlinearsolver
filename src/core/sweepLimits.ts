/** Retained sweep data has its own conservative budget. Solver scratch space,
 * worker transfers and Plotly allocations still need room outside this budget. */
export const MAX_PARAMETER_SAMPLES = 50_000;
export const MAX_SECONDARY_SLICES = 10_000;
export const MAX_DOUBLE_SWEEP_SAMPLES = 250_000;
export const DEFAULT_SWEEP_BYTES = 1000 * 1024 * 1024;
