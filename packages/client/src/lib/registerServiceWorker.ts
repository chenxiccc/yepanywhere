/**
 * 应用启动时注册 Service Worker，确保 PWA 能力（安装应用等）开箱即用
 * Register Service Worker at startup to enable PWA capabilities (install, etc.)
 * out of the box, without requiring the user to visit notification settings first.
 *
 * 与推送订阅解耦：SW 注册是所有用户都需要的 PWA 基础设施，
 * 推送订阅是用户主动选择开启的功能。
 * Decoupled from push subscription: SW registration is PWA infrastructure
 * needed by all users; push subscription is opt-in.
 */
import { api } from "../api/client";

/** Service Worker 文件路径，兼容 Vite base URL（本地的 "/" 和远程的 "/remote/"） */
const SW_PATH = `${import.meta.env.BASE_URL}sw.js`;

/** 浏览器是否支持 Service Worker */
const hasBrowserSupport =
  typeof window !== "undefined" &&
  "serviceWorker" in navigator;

/**
 * 在应用启动时注册 Service Worker。
 * 仅注册 SW 本身，不订阅推送通知。
 */
export async function registerServiceWorkerAtStartup(): Promise<void> {
  if (!hasBrowserSupport) return;

  // 开发模式下检查服务器设置，允许通过设置 UI 运行时关闭 SW
  // In dev mode, check server setting (allows runtime toggle via settings UI)
  if (import.meta.env.DEV) {
    try {
      const response = await api.getServerSettings();
      if (!response.settings.serviceWorkerEnabled) {
        console.log(
          "[registerServiceWorker] Service worker disabled by server setting",
        );
        return;
      }
    } catch {
      // 设置接口调用失败则继续注册（fail open）
      // If settings fetch fails, proceed with SW enabled (fail open)
      console.warn(
        "[registerServiceWorker] Failed to fetch server settings, proceeding with SW enabled",
      );
    }
  }

  try {
    // 对已注册的 SW 再次调用 register() 只是返回现有实例，不会重复注册
    // Calling register() on an already-registered SW returns the existing registration
    const reg = await navigator.serviceWorker.register(SW_PATH);
    console.log(
      "[registerServiceWorker] Service worker registered:",
      reg.scope,
    );
  } catch (err) {
    console.error("[registerServiceWorker] Failed to register:", err);
  }
}