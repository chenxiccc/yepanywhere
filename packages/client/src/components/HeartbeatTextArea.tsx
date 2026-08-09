import { MAX_HEARTBEAT_TURN_TEXT_LENGTH } from "@yep-anywhere/shared";
import {
  type ChangeEvent,
  type TextareaHTMLAttributes,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import styles from "./HeartbeatTextArea.module.css";

type HeartbeatTextAreaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "maxLength" | "onChange" | "rows" | "value"
> & {
  value: string;
  onChange: (value: string) => void;
};

export function HeartbeatTextArea({
  value,
  onChange,
  className,
  ...props
}: HeartbeatTextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const computed = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const chrome =
      Number.parseFloat(computed.paddingTop) +
      Number.parseFloat(computed.paddingBottom) +
      Number.parseFloat(computed.borderTopWidth) +
      Number.parseFloat(computed.borderBottomWidth);
    const maxHeight = lineHeight * 4 + chrome;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(resize);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(
      event.currentTarget.value.slice(0, MAX_HEARTBEAT_TURN_TEXT_LENGTH),
    );
  };

  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      maxLength={MAX_HEARTBEAT_TURN_TEXT_LENGTH}
      className={[styles.textarea, className].filter(Boolean).join(" ")}
      value={value}
      onChange={handleChange}
    />
  );
}
