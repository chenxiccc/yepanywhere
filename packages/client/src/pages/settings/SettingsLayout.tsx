import {
  DEVICE_BRIDGE_AVAILABLE_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { useReloadNotifications } from "../../hooks/useReloadNotifications";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  getDevelopmentCategory,
  getEmulatorCategory,
  getSettingsCategories,
} from "../../i18n-settings";
import { MainContent, useNavigationLayout } from "../../layouts";
import { AboutSettings } from "./AboutSettings";
import { AgentContextSettings } from "./AgentContextSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { CacheMissBillingSettings } from "./CacheMissBillingSettings";
import { DevelopmentSettings } from "./DevelopmentSettings";
import { DevicesSettings } from "./DevicesSettings";
import { EmulatorSettings } from "./EmulatorSettings";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { LifecycleWebhooksSettings } from "./LifecycleWebhooksSettings";
import { LocalAccessSettings } from "./LocalAccessSettings";
import { MessageDeliverySettings } from "./MessageDeliverySettings";
import { ModelSettings } from "./ModelSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { PerformanceSettings } from "./PerformanceSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { RemoteExecutorsSettings } from "./RemoteExecutorsSettings";
import { SettingsCategoryIcon } from "./SettingsCategoryIcons";
import {
  SettingsPaneTitleProvider,
  useSettingsPaneTitleRegistration,
} from "./SettingsPaneTitleContext";
import {
  SettingsUndoProvider,
  useSettingsUndoRegistration,
} from "./SettingsUndoContext";
import { SpeechSettings } from "./SpeechSettings";
import { ToolbarSettings } from "./ToolbarSettings";
import { WebhookPrivateSettings } from "./WebhookPrivateSettings";
import type { SettingsCategory } from "./types";

// Map category IDs to their components
const CATEGORY_COMPONENTS: Record<string, React.ComponentType> = {
  appearance: AppearanceSettings,
  performance: PerformanceSettings,
  toolbar: ToolbarSettings,
  model: ModelSettings,
  "cache-miss-billing": CacheMissBillingSettings,
  "message-delivery": MessageDeliverySettings,
  "agent-context": AgentContextSettings,
  notifications: NotificationsSettings,
  webhooks: LifecycleWebhooksSettings,
  "webhook-private": WebhookPrivateSettings,
  devices: DevicesSettings,
  "local-access": LocalAccessSettings,
  remote: RemoteAccessSettings,
  providers: ProvidersSettings,
  speech: SpeechSettings,
  "remote-executors": RemoteExecutorsSettings,
  emulator: EmulatorSettings,
  environment: EnvironmentSettings,
  about: AboutSettings,
  development: DevelopmentSettings,
};

// 700px leaves 685px after the stable scrollbar gutter: 32px shell padding,
// 251px current intrinsic category rail, 16px gap, and 386px detail content.
export const SETTINGS_TWO_COLUMN_MIN_WIDTH = 700;

export function shouldUseSettingsTwoColumn(availableWidth: number): boolean {
  return availableWidth >= SETTINGS_TWO_COLUMN_MIN_WIDTH;
}

interface SettingsDetailNavigationState {
  settingsDetailOpenedFromList?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function createSettingsDetailNavigationState(
  openedFromList: boolean,
): SettingsDetailNavigationState | undefined {
  return openedFromList ? { settingsDetailOpenedFromList: true } : undefined;
}

export function shouldPopSettingsDetailBack(state: unknown): boolean {
  return isRecord(state) && state.settingsDetailOpenedFromList === true;
}

export function shouldReplaceSettingsCategoryNavigation({
  currentCategory,
  useTwoColumnSettings,
}: {
  currentCategory: string | undefined;
  useTwoColumnSettings: boolean;
}): boolean {
  return useTwoColumnSettings && !!currentCategory;
}

function getInitialSettingsWidth(): number {
  return typeof window === "undefined" ? 1200 : window.innerWidth;
}

function useSettingsContainerWidth(): [
  (element: HTMLDivElement | null) => void,
  number,
] {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(getInitialSettingsWidth);

  useLayoutEffect(() => {
    if (!container) {
      return;
    }

    const updateWidth = () => {
      setWidth(container.clientWidth);
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  return [setContainer, width];
}

function scrollElementToTop(element: HTMLElement): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ top: 0, behavior: "auto" });
    return;
  }

  element.scrollTop = 0;
}

interface SettingsCategoryItemProps {
  category: SettingsCategory;
  isActive: boolean;
  onClick: () => void;
}

function SettingsCategoryItem({
  category,
  isActive,
  onClick,
}: SettingsCategoryItemProps) {
  return (
    <button
      type="button"
      className={`settings-category-item ${isActive ? "active" : ""}`}
      onClick={onClick}
    >
      <SettingsCategoryIcon id={category.id} />
      <div className="settings-category-text">
        <span className="settings-category-label">{category.label}</span>
        <span className="settings-category-description">
          {category.description}
        </span>
      </div>
      <span className="settings-category-chevron">›</span>
    </button>
  );
}

export function SettingsLayout() {
  const { t } = useI18n();
  const { category } = useParams<{ category?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = useRemoteBasePath();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const [settingsContainerRef, settingsContainerWidth] =
    useSettingsContainerWidth();
  const settingsScrollContainerRef = useRef<HTMLElement | null>(null);
  const useTwoColumnSettings = shouldUseSettingsTwoColumn(
    settingsContainerWidth,
  );
  const { isManualReloadMode } = useReloadNotifications();
  const { version: versionInfo } = useVersion();
  const {
    registration: undoRegistration,
    setRegistration: setUndoRegistration,
  } = useSettingsUndoRegistration();
  const { title: paneTitle, setTitle: setPaneTitle } =
    useSettingsPaneTitleRegistration();

  const categories: SettingsCategory[] = [
    ...getSettingsCategories((key) => t(key as never)),
  ];
  if (
    serverHasCapability(versionInfo, DEVICE_BRIDGE_CAPABILITY) ||
    serverHasCapability(versionInfo, DEVICE_BRIDGE_DOWNLOAD_CAPABILITY) ||
    serverHasCapability(versionInfo, DEVICE_BRIDGE_AVAILABLE_CAPABILITY)
  ) {
    const aboutIndex = categories.findIndex((c) => c.id === "about");
    categories.splice(
      aboutIndex >= 0 ? aboutIndex : categories.length,
      0,
      getEmulatorCategory((key) => t(key as never)),
    );
  }
  if (isManualReloadMode) {
    categories.push(getDevelopmentCategory((key) => t(key as never)));
  }
  // webhook-private：钉钉/飞书群机器人通知，插在 about 之前（保持 about 永远最后）
  // webhook-private: DingTalk/Feishu group-bot; splice before about so about stays last.
  // 文案写死（仅自用，不走 i18n 以减少与上游的冲突面）。
  // Labels are hardcoded (self-use only; skip i18n to avoid upstream merge conflicts).
  {
    const aboutIndex = categories.findIndex((c) => c.id === "about");
    categories.splice(aboutIndex >= 0 ? aboutIndex : categories.length, 0, {
      id: "webhook-private",
      label: "群机器人通知",
      description: "钉钉/飞书群机器人推送",
    });
  }

  // Two-column settings can fit before the persistent app sidebar can.
  const effectiveCategory =
    category || (useTwoColumnSettings ? categories[0]?.id : undefined);

  const setSettingsScrollContainerRef = useCallback(
    (element: HTMLElement | null) => {
      settingsScrollContainerRef.current = element;
    },
    [],
  );

  const scrollSettingsToTop = useCallback(() => {
    const element = settingsScrollContainerRef.current;
    if (element) {
      scrollElementToTop(element);
    }
  }, []);

  useLayoutEffect(() => {
    void location.key;
    scrollSettingsToTop();
  }, [location.key, scrollSettingsToTop]);

  const navigateToSettingsRoot = () => {
    if (shouldPopSettingsDetailBack(location.state)) {
      navigate(-1);
    } else {
      navigate(`${basePath}/settings`, { replace: !!category });
    }
    scrollSettingsToTop();
  };

  const handleSettingsTitleClick = () => {
    if (category) {
      navigateToSettingsRoot();
      return;
    }

    navigate(`${basePath}/settings`, { replace: true });
    scrollSettingsToTop();
  };

  const handleCategoryClick = (categoryId: string) => {
    const openedFromList =
      !category || shouldPopSettingsDetailBack(location.state);
    navigate(`${basePath}/settings/${categoryId}`, {
      replace: shouldReplaceSettingsCategoryNavigation({
        currentCategory: category,
        useTwoColumnSettings,
      }),
      state: createSettingsDetailNavigationState(openedFromList),
    });
  };

  const handleBack = () => {
    navigateToSettingsRoot();
  };

  const CategoryComponent = effectiveCategory
    ? CATEGORY_COMPONENTS[effectiveCategory]
    : null;
  const activeCategory = categories.find((c) => c.id === effectiveCategory);

  // Top-strip title for the open pane: the pane registers it via
  // useSettingsPaneTitle; fall back to the category label until that
  // registers (and for the rare pane that sets nothing).
  const resolvedPaneTitle =
    paneTitle ?? activeCategory?.label ?? t("pageTitleSettings");
  const breadcrumbDescription =
    effectiveCategory === "model"
      ? t("modelSettingsSessionDefaultsDescription")
      : null;

  // Settings breadcrumb shown in the header strip (two-column): a clickable
  // "Settings" root plus the active pane title, so the strip names the page
  // instead of just "Settings".
  const settingsBreadcrumb = (
    <span className="settings-breadcrumb">
      <button
        type="button"
        className="session-title settings-breadcrumb-root"
        onClick={handleSettingsTitleClick}
      >
        {t("pageTitleSettings")}
      </button>
      <span className="settings-breadcrumb-sep" aria-hidden="true">
        ›
      </span>
      <span className="settings-breadcrumb-current">{resolvedPaneTitle}</span>
      {breadcrumbDescription && (
        <span className="settings-breadcrumb-description">
          {breadcrumbDescription}
        </span>
      )}
    </span>
  );

  const canUndoSettingsChange = undoRegistration?.canUndo ?? false;

  // The single per-pane Undo affordance: panes register via useSettingsUndo.
  // Keep the button's header footprint even while hidden so settings rows do
  // not shift when a field first becomes undoable.
  const undoButton = (
    <button
      type="button"
      className="settings-button"
      onClick={() => void undoRegistration?.undo()}
      title={t("settingsUndoChangesTooltip")}
      disabled={!canUndoSettingsChange}
      aria-hidden={!canUndoSettingsChange}
      tabIndex={canUndoSettingsChange ? 0 : -1}
      style={{ visibility: canUndoSettingsChange ? "visible" : "hidden" }}
    >
      {t("settingsUndoChanges")}
    </button>
  );

  // Narrow settings: category list OR category detail (not both)
  if (!useTwoColumnSettings) {
    if (!category) {
      // Show category list
      return (
        <MainContent
          isWideScreen={isWideScreen}
          innerRef={settingsContainerRef}
        >
          <PageHeader
            title={t("pageTitleSettings")}
            onTitleClick={handleSettingsTitleClick}
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main
            ref={setSettingsScrollContainerRef}
            className="page-scroll-container"
          >
            <div className="page-content-inner settings-category-list-shell">
              <div className="settings-category-list">
                {categories.map((cat) => (
                  <SettingsCategoryItem
                    key={cat.id}
                    category={cat}
                    isActive={false}
                    onClick={() => handleCategoryClick(cat.id)}
                  />
                ))}
              </div>
            </div>
          </main>
        </MainContent>
      );
    }

    // Show category detail with back button
    return (
      <MainContent isWideScreen={isWideScreen} innerRef={settingsContainerRef}>
        <PageHeader
          title={resolvedPaneTitle}
          onOpenSidebar={openSidebar}
          showBack
          onBack={handleBack}
          actions={undoButton}
        />
        <main
          ref={setSettingsScrollContainerRef}
          className="page-scroll-container"
        >
          <div className="page-content-inner">
            <SettingsPaneTitleProvider value={setPaneTitle}>
              <SettingsUndoProvider value={setUndoRegistration}>
                {CategoryComponent && <CategoryComponent />}
              </SettingsUndoProvider>
            </SettingsPaneTitleProvider>
          </div>
        </main>
      </MainContent>
    );
  }

  // Desktop: two-column layout with category list on left, content on right
  return (
    <MainContent isWideScreen={isWideScreen} innerRef={settingsContainerRef}>
      <PageHeader
        title={resolvedPaneTitle}
        titleElement={settingsBreadcrumb}
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
        actions={undoButton}
      />
      <main
        ref={setSettingsScrollContainerRef}
        className="page-scroll-container"
      >
        <div className="settings-two-column">
          <nav className="settings-category-nav">
            <div className="settings-category-list">
              {categories.map((cat) => (
                <SettingsCategoryItem
                  key={cat.id}
                  category={cat}
                  isActive={effectiveCategory === cat.id}
                  onClick={() => handleCategoryClick(cat.id)}
                />
              ))}
            </div>
          </nav>
          <div className="settings-content-panel">
            <SettingsPaneTitleProvider value={setPaneTitle}>
              <SettingsUndoProvider value={setUndoRegistration}>
                {CategoryComponent && <CategoryComponent />}
              </SettingsUndoProvider>
            </SettingsPaneTitleProvider>
          </div>
        </div>
      </main>
    </MainContent>
  );
}
