import type { Configuration, Variable } from './core/types';
const parameter = (name: string, value: number, min: number, max: number, step: number): Variable => ({ name, value, min, max, step, kind: 'parameter' });
// Example guesses are starting points, not physical restrictions on edited equations.
const unknown = (name: string, value: number): Variable => ({ name, value, kind: 'unknown' });
const base = { constraints: '', solver: { tolerance: 1e-9, iterations: 100, starts: 12 }, sweep: { parameter: 'VG', min: 0, max: 3.3, points: 121, logarithmic: false, mode: 'free' as const, release: '' } };
export const rcLowPass: Configuration = {
  ...base, name: 'RC low-pass filter',
  description: 'Complex frequency response from the RC node equation. Gain in dB and phase in degrees share the Y scale.',
  equations: '# Series resistor R, capacitor C from Vout to ground\n# Frequency f is in Hz; omega is in rad/s\nomega = 2*pi*f;\n\n# Resistor current equals capacitor current\n(Vin - Vout)/R = i*omega*C*Vout;\n\n# Transfer function and real plotting quantities\nH = Vout/Vin;\ngain_dB = 20*log10(abs(H));\nphase_deg = arg(H)*180/pi;\ncutoff_Hz = 1/(2*pi*R*C);',
  variables: [parameter('f', 0, 0, 10000, 25), parameter('R', 1000, 100, 10000, 100), parameter('C', 100e-9, 10e-9, 1e-6, 10e-9), parameter('Vin', 1, .1, 5, .1)],
  solver: { ...base.solver, complex: true },
  sweep: { ...base.sweep, parameter: 'f', min: 0, max: 10000, points: 401 },
  axes: { x: 'f', y: 'gain_dB, phase_deg', transitions: [
    { axis: 'x', expression: 'cutoff_Hz' }, { axis: 'y', expression: '-10*log10(2)' },
  ] }, regions: [],
};
export const defaultWorkspace = rcLowPass;
export const examples: Configuration[] = [
  { ...base, name: 'NMOS common source', description: 'A resistor-loaded NMOS, from cutoff to saturation and triode.',
    equations: '# Drain-node KCL\n(VDD - VD) / RD = ID;\n\n# Piecewise square-law model\nID = if(\n  VG <= VTH,\n  0,\n  if(\n    VD < VG - VTH,\n    K * ((VG - VTH) * VD - VD^2 / 2)\n      * (1 + LAMBDA * VD),\n    K / 2 * (VG - VTH)^2\n      * (1 + LAMBDA * VD)\n  )\n);\nVOV = VG - VTH;',
    variables: [unknown('VD', 1.65), unknown('ID', .0005), parameter('VG', 1.5, 0, 3.3, .01), parameter('VDD', 3.3, 1, 5, .01), parameter('RD', 2200, 100, 10000, 100), parameter('VTH', .7, .1, 1.5, .01), parameter('K', .001, .0001, .005, .0001), parameter('LAMBDA', .02, 0, .1, .001)],
    axes: { x: 'VG', y: 'VD' }, regions: [] },
  { ...base, name: 'CMOS inverter', description: 'Matched square-law NMOS and PMOS with channel-length modulation.',
    equations: '# NMOS and PMOS currents balance at the output\nIN = if(VIN <= VTN, 0, if(VOUT < VIN - VTN, KN * ((VIN - VTN) * VOUT - VOUT^2 / 2) * (1 + LAMBDA * VOUT), KN / 2 * (VIN - VTN)^2 * (1 + LAMBDA * VOUT)));\nIP = if(VDD - VIN <= VTP, 0, if(VDD - VOUT < VDD - VIN - VTP, KP * ((VDD - VIN - VTP) * (VDD - VOUT) - (VDD - VOUT)^2 / 2) * (1 + LAMBDA * (VDD - VOUT)), KP / 2 * (VDD - VIN - VTP)^2 * (1 + LAMBDA * (VDD - VOUT))));\nIN = IP;',
    variables: [unknown('VOUT', 1.65), unknown('IN', .0001), unknown('IP', .0001), parameter('VIN', 1.5, 0, 3.3, .01), parameter('VDD', 3.3, 1.8, 5, .01), parameter('VTN', .7, .2, 1, .01), parameter('VTP', .7, .2, 1, .01), parameter('KN', .001, .0001, .004, .0001), parameter('KP', .001, .0001, .004, .0001), parameter('LAMBDA', .04, .001, .1, .001)],
    sweep: { ...base.sweep, parameter: 'VIN' }, axes: { x: 'VIN', y: 'VOUT' }, regions: [] },
  { ...base, name: 'Cubic · multiple roots', description: 'Explore the three real branches of x³ − x = p and their folds.', equations: 'x^3 - x = p;\nx >= -2;\nx <= 2;', variables: [unknown('x', .8), parameter('p', 0, -.6, .6, .005)], sweep: { ...base.sweep, parameter: 'p', min: -.6, max: .6, points: 161 }, axes: { x: 'p', y: 'x' }, regions: [] },
  rcLowPass,
];
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export const starter: Configuration = {
  ...clone(base), name: 'Equation workspace', description: '',
  equations: 'y = a*x + b;',
  variables: [unknown('y', 1), parameter('x', 0, -5, 5, .1), parameter('a', 1, -5, 5, .1), parameter('b', 0, -5, 5, .1)],
  axes: { x: 'x', y: 'y' }, sweep: { ...base.sweep, parameter: 'x', min: -5, max: 5 }, regions: [],
};
