import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY_PREFIX = "source-file-panel-width";

interface UsePanelResizeOptions {
  /** 初始宽度（px）/ Initial width in pixels */
  initialWidth: number;
  /** 最小宽度（px）/ Minimum width in pixels */
  minWidth: number;
  /** 最大宽度（px）/ Maximum width in pixels */
  maxWidth: number;
  /** localStorage 键名 / localStorage key */
  storageKey: string;
}

/**
 * 面板拖拽调整 Hook，参考 Sidebar resize 实现
 * Panel resize hook, modeled after the Sidebar resize implementation.
 *
 * 不与 Sidebar 的 resize 逻辑耦合，独立封装
 * Independent from Sidebar resize — uses its own localStorage key and clamp range.
 */
export function usePanelResize({
  initialWidth,
  minWidth,
  maxWidth,
  storageKey,
}: UsePanelResizeOptions) {
  const fullKey = `${STORAGE_KEY_PREFIX}-${storageKey}`;

  const [width, setWidthState] = useState(() => {
    if (typeof window === "undefined") return initialWidth;
    const stored = localStorage.getItem(fullKey);
    if (stored === null) return initialWidth;
    const parsed = Number.parseInt(stored, 10);
    if (Number.isNaN(parsed)) return initialWidth;
    return clamp(parsed, minWidth, maxWidth);
  });

  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef<number | null>(null);
  const resizeStartWidth = useRef<number | null>(null);

  const setWidth = useCallback(
    (newWidth: number) => {
      const clamped = clamp(newWidth, minWidth, maxWidth);
      setWidthState(clamped);
      localStorage.setItem(fullKey, String(clamped));
    },
    [fullKey, minWidth, maxWidth],
  );

  // 拖拽处理 / Resize handling
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartX.current = e.clientX;
      resizeStartWidth.current = width;
      setIsResizing(true);
    },
    [width],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizeStartX.current === null || resizeStartWidth.current === null)
        return;
      const diff = e.clientX - resizeStartX.current;
      const newWidth = resizeStartWidth.current + diff;
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      resizeStartX.current = null;
      resizeStartWidth.current = null;
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, setWidth]);

  const resizeHandleProps = {
    onMouseDown: handleMouseDown,
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-valuemin": minWidth,
    "aria-valuemax": maxWidth,
    "aria-valuenow": width,
    tabIndex: 0,
  };

  return { width, setWidth, isResizing, resizeHandleProps };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}