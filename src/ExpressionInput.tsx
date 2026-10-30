import { useEffect, useId, useRef, useState } from 'react';
import { numericExpression } from './core/numeric';

interface Props {
  value: number | undefined;
  onValue: (value: number | undefined) => void;
  onValidity: (id: string, error: string | null) => void;
  onRevert: (error: string) => void;
  onValid: () => void;
  label: string;
  optional?: boolean;
}

/** Keeps incomplete text while editing and only commits successfully evaluated numbers. */
export default function ExpressionInput({ value, onValue, onValidity, onRevert, onValid, label, optional = false }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [focused, setFocused] = useState(false);
  const lastAccepted = useRef(value);
  const problem = useRef('');

  useEffect(() => {
    if (!focused && value !== lastAccepted.current) {
      lastAccepted.current = value;
      setDraft(value === undefined ? '' : String(value));
    }
  }, [value, focused]);
  useEffect(() => () => onValidity(id, null), [id, onValidity]);

  const update = (text: string) => {
    setDraft(text);
    try {
      const result = text.trim() === '' && optional ? undefined : numericExpression(text);
      problem.current = ''; onValidity(id, null); onValid();
      if (result !== lastAccepted.current) { lastAccepted.current = result; onValue(result); }
    } catch (error) {
      problem.current = `${label}: ${error instanceof Error ? error.message : 'Invalid numeric expression.'}`;
      onValidity(id, problem.current);
    }
  };

  return <input type="text" inputMode="decimal" aria-label={label} aria-invalid={Boolean(problem.current)} title="Use a number or numeric expression, such as 9e-9 or 9*10^(-9)." value={draft} onFocus={() => setFocused(true)} onChange={event => update(event.target.value)} onBlur={() => {
    setFocused(false);
    if (problem.current) {
      onRevert(`${problem.current} The previous value was restored.`);
      problem.current = ''; onValidity(id, null);
      setDraft(value === undefined ? '' : String(value)); lastAccepted.current = value;
    }
  }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
}
