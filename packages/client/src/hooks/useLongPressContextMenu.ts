/**
 * 移动端长按菜单 hook / Mobile long-press context menu hook.
 *
 * 实现双轨触发：onContextMenu（桌面右键+移动端原生长按）
 * 和 onTouchStart 定时器（移动端长按 fallback），同时防止长按后
 * 触发 click 事件。
 * Implements dual-track trigger: onContextMenu (desktop right-click +
 * mobile native long-press) and onTouchStart timer (mobile long-press
 * fallback), while suppressing click after long-press.
 */
import { useCallback, useEffect, useRef } from "react";

export function useLongPressContextMenu(onOpen: (x: number, y: number) => void) {
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextClickRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // 右键菜单 / Context menu handler
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onOpen(e.clientX, e.clientY);
    },
    [onOpen],
  );

  // 移动端长按 / Mobile long-press
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      clearLongPress();
      longPressTimerRef.current = setTimeout(() => {
        suppressNextClickRef.current = true;
        window.setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 800);
        onOpen(touch.clientX, touch.clientY);
      }, 450);
    },
    [onOpen, clearLongPress],
  );

  const handleTouchMove = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleTouchEnd = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  useEffect(() => {
    return () => clearLongPress();
  }, [clearLongPress]);

  // 包装 click 处理，消费长按标记 / Wrap click handler to consume long-press flag
  const wrapClick = useCallback(
    (handler: () => void) => {
      return () => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          return;
        }
        handler();
      };
    },
    [],
  );

  return {
    handleContextMenu,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    wrapClick,
  };
}