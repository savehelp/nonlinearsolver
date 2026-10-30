import { equationStatements } from './expression';
import { migrateUnknownBounds } from './constraints';
import type { Configuration } from './types';

/** Add terminators to legacy newline-separated input without dropping comments. */
function terminateLegacy(source: string): string {
  let output = '', depth = 0, content = false, comment = false;
  for (const char of source) {
    if (char === '\n') {
      if (!comment && depth === 0 && content) output += ';';
      output += char; comment = false;
      if (depth === 0) content = false;
      continue;
    }
    if (comment) { output += char; continue; }
    if (char === '#') {
      if (depth === 0 && content) { output += ';'; content = false; }
      comment = true; output += char; continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char.trim()) content = true;
    output += char;
  }
  if (!comment && content) output += ';';
  return output;
}

/** Move older separate derived definitions and validity fields into the editor.
 * Existing equation text stays intact, including malformed input for correction. */
export function migrateEquationInputs(config: Configuration): void {
  migrateUnknownBounds(config);
  const derived = config.variables.filter(variable => variable.kind === 'derived');
  const conditions = config.constraints.split('\n').map(line => {
    const at = line.indexOf('#');
    const expression = (at < 0 ? line : line.slice(0, at)).trim();
    const comment = at < 0 ? '' : line.slice(at);
    return expression ? `valid ${expression};${comment ? ` ${comment}` : ''}` : comment;
  }).filter(Boolean);
  if (!derived.length && !conditions.length) { config.constraints = ''; return; }

  let equations = config.equations;
  try {
    equationStatements(equations);
    if (!equations.replace(/#[^\r\n]*/g, '').includes(';')) equations = terminateLegacy(equations);
  } catch { /* Retain the original syntax error instead of silently repairing it. */ }
  const additions = [
    ...derived.map(variable => `${variable.name} = ${variable.expression ?? ''};`),
    ...conditions,
  ];
  config.equations = [equations.trimEnd(), ...additions].filter(Boolean).join('\n');
  config.variables = config.variables.filter(variable => variable.kind !== 'derived');
  config.constraints = '';
}
