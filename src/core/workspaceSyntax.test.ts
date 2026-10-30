import { describe, expect, it } from 'vitest';
import { clone, starter, validateImport } from '../examples';
import { equationStatements } from './expression';
import { migrateEquationInputs } from './workspaceSyntax';

describe('unified equation input migration', () => {
  it('moves derived definitions and every legacy validity condition once', () => {
    const config = clone(starter);
    config.variables.push({ name: 'twice', kind: 'derived', value: 0, expression: '2*y' });
    config.constraints = '# physical domain\ny >= 0 # inclusive\ny <= 10';
    migrateEquationInputs(config);
    expect(config.variables.some(variable => variable.kind === 'derived')).toBe(false);
    expect(config.constraints).toBe('');
    expect(config.equations).toContain('twice = 2*y;');
    expect(config.equations).toContain('# physical domain');
    expect(config.equations).toContain('valid y >= 0; # inclusive');
    expect(config.equations).toContain('valid y <= 10;');
    const migrated = clone(config); migrateEquationInputs(config);
    expect(config).toEqual(migrated);
  });

  it('adds legacy unknown bounds to equations while retaining parameter sliders', () => {
    const config = clone(starter);
    Object.assign(config.variables[0], { min: 0, max: 5 });
    const parameter = clone(config.variables[1]);
    migrateEquationInputs(config);
    expect(config.equations).toContain('valid y >= 0;');
    expect(config.equations).toContain('valid y <= 5;');
    expect(config.variables[0].min).toBeUndefined();
    expect(config.variables[0].max).toBeUndefined();
    expect(config.variables[1]).toEqual(parameter);
  });

  it('keeps separate legacy equations, multiline expressions, and comments', () => {
    const config = clone(starter);
    config.equations = '# model\ny = max(\n x,\n 0\n) # chosen branch\nz = y + 1\n# tail';
    config.constraints = 'y >= 0';
    migrateEquationInputs(config);
    expect(equationStatements(config.equations)).toEqual(['y = max(\n x,\n 0\n)', 'z = y + 1', 'valid y >= 0']);
    expect(config.equations).toContain('# model');
    expect(config.equations).toContain(';# chosen branch');
    expect(config.equations).toContain('# tail');
  });

  it('preserves invalid equation input for editing', () => {
    const config = clone(starter);
    config.equations = 'y=x;\nz ='; config.constraints = 'y >= 0';
    migrateEquationInputs(config);
    expect(config.equations.startsWith('y=x;\nz =\n')).toBe(true);
    expect(config.equations).toContain('valid y >= 0;');
  });

  it('ignores semicolons in legacy comments when adding terminators', () => {
    const config = clone(starter);
    config.equations = '# a comment; not a delimiter\ny = x\nz = y + 1';
    config.constraints = 'y >= 0';
    migrateEquationInputs(config);
    expect(equationStatements(config.equations)).toEqual(['y = x', 'z = y + 1', 'valid y >= 0']);
    expect(config.equations).toContain('# a comment; not a delimiter');
  });

  it('keeps cyclic derived relationships explicit and round-trips imports', () => {
    const config = clone(starter);
    config.variables.push({ name: 'u', kind: 'derived', value: 0, expression: 'v + 1' }, { name: 'v', kind: 'derived', value: 0, expression: '2*u' });
    const imported = validateImport(config);
    expect(imported.equations).toContain('u = v + 1;\nv = 2*u;');
    expect(imported.variables.some(variable => variable.kind === 'derived')).toBe(false);
    expect(validateImport(JSON.parse(JSON.stringify(imported)))).toEqual(imported);
    expect(config.variables.some(variable => variable.kind === 'derived')).toBe(true);
  });
});
