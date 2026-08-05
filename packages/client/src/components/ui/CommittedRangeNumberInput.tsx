import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { CommittedRangeInput } from "./CommittedRangeInput";

interface CommittedRangeNumberInputProps {
  id?: string;
  min: number;
  max: number;
  numberMin?: number;
  numberMax?: number;
  step?: number;
  list?: string;
  value: number;
  unit?: ReactNode;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  onEdit?: () => void;
  onCommit: (value: number) => void;
  snapTextToStep?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function CommittedRangeNumberInput({
  id,
  min,
  max,
  numberMin = min,
  numberMax = max,
  step = 1,
  list,
  value,
  unit,
  disabled,
  ariaLabel,
  className,
  onEdit,
  onCommit,
  snapTextToStep = true,
}: CommittedRangeNumberInputProps) {
  const [rangeValue, setRangeValue] = useState(() => clamp(value, min, max));
  const [textDraft, setTextDraft] = useState(String(value));

  useEffect(() => {
    setRangeValue(clamp(value, min, max));
    setTextDraft(String(value));
  }, [max, min, value]);

  const normalizeRange = useCallback(
    (next: number) => {
      const stepped = min + Math.round((next - min) / step) * step;
      return clamp(stepped, min, max);
    },
    [max, min, step],
  );

  const resetDraft = useCallback(() => {
    setRangeValue(clamp(value, min, max));
    setTextDraft(String(value));
  }, [max, min, value]);

  const commit = useCallback(
    (next: number, snapToStep = true, lowerBound = min, upperBound = max) => {
      const normalized = snapToStep
        ? normalizeRange(next)
        : clamp(next, lowerBound, upperBound);
      setRangeValue(clamp(normalized, min, max));
      setTextDraft(String(normalized));
      onCommit(normalized);
    },
    [max, min, normalizeRange, onCommit],
  );

  const commitText = useCallback(() => {
    if (textDraft.trim() === "") {
      resetDraft();
      return;
    }
    const parsed = Number(textDraft);
    if (!Number.isFinite(parsed)) {
      resetDraft();
      return;
    }
    commit(parsed, snapTextToStep, numberMin, numberMax);
  }, [commit, numberMax, numberMin, resetDraft, snapTextToStep, textDraft]);

  const handleTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitText();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      resetDraft();
      event.currentTarget.blur();
    }
  };

  return (
    <span
      className={
        className
          ? `output-appearance-slider-row ${className}`
          : "output-appearance-slider-row"
      }
    >
      <CommittedRangeInput
        id={id}
        min={min}
        max={max}
        step={step}
        list={list}
        value={rangeValue}
        disabled={disabled}
        aria-label={ariaLabel}
        onDraftChange={(next) => {
          setTextDraft(String(next));
          onEdit?.();
        }}
        onCommit={commit}
      />
      <span className="output-appearance-number-wrap">
        <input
          id={id ? `${id}-number` : undefined}
          type="number"
          className="settings-input-small output-appearance-number"
          min={numberMin}
          max={numberMax}
          step={snapTextToStep ? step : "any"}
          value={textDraft}
          disabled={disabled}
          aria-label={ariaLabel}
          onChange={(event) => {
            const nextText = event.currentTarget.value;
            setTextDraft(nextText);
            if (nextText.trim() === "") return;
            const parsed = Number(nextText);
            if (!Number.isFinite(parsed)) return;
            setRangeValue(clamp(parsed, min, max));
            onEdit?.();
          }}
          onBlur={commitText}
          onKeyDown={handleTextKeyDown}
        />
        {unit && <span className="output-appearance-unit">{unit}</span>}
      </span>
    </span>
  );
}
