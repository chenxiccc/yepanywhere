import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import {
  dispatchSessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import {
  getActiveSearchAnchors,
  getAllTurnSearchAnchors,
  getFullSessionSearchAnchors,
  getSearchMatchProjection,
  getSearchNavigatorStateProjection,
  getSearchPanelProjection,
  getSearchReady,
  getSearchSelectionProjection,
  getSearchVisibleTurnGroups,
  getUserTurnNavAnchors,
  getUserTurnSearchAnchors,
  hasSearchableUserTurn,
  type RenderTurnGroup,
} from "../lib/sessionDetail/renderSelectors";
import type { RenderItem } from "../types/renderItems";
import type {
  UserTurnNavAnchor,
  UserTurnNavSearchState,
} from "../components/UserTurnNavigator";
import styles from "./useMessageListIsearch.module.css";

const SEARCH_ARROW_REPEAT_DELAY_MS = 150;
const SEARCH_ARROW_REPEAT_INTERVAL_MS = 42;

interface UserTurnSearchSession {
  active: boolean;
  scope: SessionIsearchScope;
  query: string;
  caseSensitive: boolean;
  selectedId: string | null;
  originalScrollTop: number | null;
}

interface UseMessageListIsearchOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  displayRenderItems: readonly RenderItem[];
  inert: boolean;
  turnGroups: readonly RenderTurnGroup[];
}

interface UseMessageListIsearchResult {
  active: boolean;
  scope: SessionIsearchScope;
  visibleTurnGroups: readonly RenderTurnGroup[];
  getNavigatorAnchors: () => UserTurnNavAnchor[];
  searchState: UserTurnNavSearchState | null;
  searchPanel: ReactNode;
  closeSearch: (restoreScroll: boolean) => void;
  getSelectedSearchTargetId: () => string | null;
  handleSearchArrowKey: (
    direction: "previous" | "next",
    repeat: boolean,
  ) => void;
  moveSearchSelection: (direction: "previous" | "next") => void;
  openSearch: (scope: SessionIsearchScope) => void;
  selectSearchMatch: (id: string, targetId?: string) => void;
  stopSearchArrowRepeat: () => void;
}

export function useMessageListIsearch({
  containerRef,
  displayRenderItems,
  inert,
  turnGroups,
}: UseMessageListIsearchOptions): UseMessageListIsearchResult {
  const { t } = useI18n();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRestoreFocusRef = useRef<HTMLElement | null>(null);
  const searchOriginalScrollTopRef = useRef<number | null>(null);
  const committedSearchTargetIdRef = useRef<string | null>(null);
  const selectedSearchTargetIdRef = useRef<string | null>(null);
  const searchArrowRepeatTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const searchArrowRepeatIntervalRef = useRef<ReturnType<
    typeof setInterval
  > | null>(null);
  const searchArrowRepeatDirectionRef = useRef<"previous" | "next" | null>(
    null,
  );
  const [userTurnSearch, setUserTurnSearch] = useState<UserTurnSearchSession>({
    active: false,
    scope: "user",
    query: "",
    caseSensitive: false,
    selectedId: null,
    originalScrollTop: null,
  });

  const hasUserSearchableTurn = useMemo(
    () => hasSearchableUserTurn(displayRenderItems),
    [displayRenderItems],
  );
  const getUserTurnNavAnchorList = useCallback(
    (): UserTurnNavAnchor[] => getUserTurnNavAnchors(displayRenderItems),
    [displayRenderItems],
  );
  const searchReady = getSearchReady({
    active: userTurnSearch.active,
    query: userTurnSearch.query,
  });
  const includeUserTurnSearchAnchors =
    searchReady && userTurnSearch.scope === "user";
  const userTurnSearchAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeUserTurnSearchAnchors) {
      return [];
    }
    return getUserTurnSearchAnchors(displayRenderItems);
  }, [includeUserTurnSearchAnchors, displayRenderItems]);
  const includeAllTurnSearchAnchors =
    searchReady && userTurnSearch.scope === "all";
  const sessionTurnNavAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeAllTurnSearchAnchors) {
      return [];
    }
    return getAllTurnSearchAnchors(displayRenderItems);
  }, [includeAllTurnSearchAnchors, displayRenderItems]);
  const includeFullSessionSearchAnchors =
    searchReady && userTurnSearch.scope === "full";
  const fullSessionSearchAnchors = useMemo<UserTurnNavAnchor[]>(() => {
    if (!includeFullSessionSearchAnchors) {
      return [];
    }
    return getFullSessionSearchAnchors(turnGroups);
  }, [includeFullSessionSearchAnchors, turnGroups]);
  const activeSearchAnchors = getActiveSearchAnchors({
    allAnchors: sessionTurnNavAnchors,
    fullAnchors: fullSessionSearchAnchors,
    scope: userTurnSearch.scope,
    userAnchors: userTurnSearchAnchors,
  });
  const userTurnSearchProjection = useMemo(
    () =>
      getSearchMatchProjection({
        anchors: activeSearchAnchors,
        caseSensitive: userTurnSearch.caseSensitive,
        query: userTurnSearch.query,
        searchReady,
      }),
    [
      activeSearchAnchors,
      searchReady,
      userTurnSearch.caseSensitive,
      userTurnSearch.query,
    ],
  );
  const userTurnSearchMatches = userTurnSearchProjection.matches;
  const userTurnSearchMatchIds = userTurnSearchProjection.matchIds;
  const userTurnSearchMatchTargetIds = userTurnSearchProjection.matchTargetIds;
  const userTurnSearchPreviewsById = userTurnSearchProjection.previewsById;
  const userTurnSearchSelectionProjection = useMemo(
    () =>
      getSearchSelectionProjection({
        anchors: activeSearchAnchors,
        previewsById: userTurnSearchPreviewsById,
        searchReady,
        selectedId: userTurnSearch.selectedId,
      }),
    [
      activeSearchAnchors,
      searchReady,
      userTurnSearch.selectedId,
      userTurnSearchPreviewsById,
    ],
  );
  const selectedSearchAnchor = userTurnSearchSelectionProjection.selectedAnchor;
  const selectedSearchTargetId =
    userTurnSearchSelectionProjection.selectedTargetId;
  selectedSearchTargetIdRef.current = selectedSearchTargetId;
  const userTurnSearchPreview =
    userTurnSearchSelectionProjection.selectedPreview;
  const searchPanelProjection = useMemo(
    () =>
      getSearchPanelProjection({
        matches: userTurnSearchMatches,
        scope: userTurnSearch.scope,
        searchReady,
        selectedId: userTurnSearch.selectedId,
      }),
    [
      searchReady,
      userTurnSearch.scope,
      userTurnSearch.selectedId,
      userTurnSearchMatches,
    ],
  );
  const getNavigatorAnchors = useCallback(
    () =>
      searchReady
        ? userTurnSearchMatches
        : userTurnSearch.active
          ? []
          : getUserTurnNavAnchorList(),
    [
      getUserTurnNavAnchorList,
      searchReady,
      userTurnSearch.active,
      userTurnSearchMatches,
    ],
  );
  const searchState = useMemo<UserTurnNavSearchState | null>(
    () =>
      getSearchNavigatorStateProjection({
        caseSensitive: userTurnSearch.caseSensitive,
        matchIds: userTurnSearchMatchIds,
        preview: userTurnSearchPreview,
        previewsById: userTurnSearchPreviewsById,
        query: userTurnSearch.query,
        searchReady,
        selectedAnchorId: selectedSearchAnchor?.id,
      }),
    [
      searchReady,
      selectedSearchAnchor?.id,
      userTurnSearch.caseSensitive,
      userTurnSearch.query,
      userTurnSearchPreviewsById,
      userTurnSearchMatchIds,
      userTurnSearchPreview,
    ],
  );
  const visibleTurnGroups = useMemo(() => {
    return getSearchVisibleTurnGroups({
      matchIds: userTurnSearchMatchIds,
      matchTargetIds: userTurnSearchMatchTargetIds,
      scope: userTurnSearch.scope,
      searchReady,
      turnGroups,
    });
  }, [
    searchReady,
    turnGroups,
    userTurnSearch.scope,
    userTurnSearchMatchIds,
    userTurnSearchMatchTargetIds,
  ]);

  useEffect(() => {
    dispatchSessionIsearchGuideState({
      active: userTurnSearch.active,
      scope: userTurnSearch.scope,
    });
  }, [userTurnSearch.active, userTurnSearch.scope]);

  useEffect(
    () => () => {
      dispatchSessionIsearchGuideState({ active: false, scope: "user" });
    },
    [],
  );

  const moveSearchSelection = useCallback(
    (direction: "previous" | "next") => {
      committedSearchTargetIdRef.current = null;
      setUserTurnSearch((previous) => {
        if (!previous.active || userTurnSearchMatches.length === 0) {
          return previous;
        }
        const currentIndex = previous.selectedId
          ? userTurnSearchMatches.findIndex(
              (anchor) => anchor.id === previous.selectedId,
            )
          : -1;
        const step = direction === "previous" ? -1 : 1;
        const fallbackIndex =
          direction === "previous" ? userTurnSearchMatches.length - 1 : 0;
        const nextIndex =
          currentIndex >= 0
            ? (currentIndex + step + userTurnSearchMatches.length) %
              userTurnSearchMatches.length
            : fallbackIndex;
        const nextSelectedId = userTurnSearchMatches[nextIndex]?.id ?? null;
        return { ...previous, selectedId: nextSelectedId };
      });
    },
    [userTurnSearchMatches],
  );
  const stopSearchArrowRepeat = useCallback(() => {
    if (searchArrowRepeatTimeoutRef.current !== null) {
      clearTimeout(searchArrowRepeatTimeoutRef.current);
      searchArrowRepeatTimeoutRef.current = null;
    }
    if (searchArrowRepeatIntervalRef.current !== null) {
      clearInterval(searchArrowRepeatIntervalRef.current);
      searchArrowRepeatIntervalRef.current = null;
    }
    searchArrowRepeatDirectionRef.current = null;
  }, []);
  const startSearchArrowRepeat = useCallback(
    (direction: "previous" | "next") => {
      if (
        searchArrowRepeatDirectionRef.current === direction &&
        (searchArrowRepeatTimeoutRef.current !== null ||
          searchArrowRepeatIntervalRef.current !== null)
      ) {
        return;
      }
      stopSearchArrowRepeat();
      searchArrowRepeatDirectionRef.current = direction;
      searchArrowRepeatTimeoutRef.current = setTimeout(() => {
        searchArrowRepeatTimeoutRef.current = null;
        moveSearchSelection(direction);
        searchArrowRepeatIntervalRef.current = setInterval(() => {
          moveSearchSelection(direction);
        }, SEARCH_ARROW_REPEAT_INTERVAL_MS);
      }, SEARCH_ARROW_REPEAT_DELAY_MS);
    },
    [moveSearchSelection, stopSearchArrowRepeat],
  );
  const handleSearchArrowKey = useCallback(
    (direction: "previous" | "next", repeat: boolean) => {
      if (!repeat || searchArrowRepeatDirectionRef.current !== direction) {
        moveSearchSelection(direction);
        startSearchArrowRepeat(direction);
      }
    },
    [moveSearchSelection, startSearchArrowRepeat],
  );
  const selectSearchMatch = useCallback((id: string, targetId?: string) => {
    committedSearchTargetIdRef.current = targetId ?? id;
    setUserTurnSearch((previous) =>
      previous.active ? { ...previous, selectedId: id } : previous,
    );
    requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
  }, []);
  const closeSearch = useCallback(
    (restoreScroll: boolean) => {
      const committedTargetId = committedSearchTargetIdRef.current;
      committedSearchTargetIdRef.current = null;
      const restoreOriginalPosition = restoreScroll && !committedTargetId;
      const scrollTopToRestore = restoreOriginalPosition
        ? searchOriginalScrollTopRef.current
        : null;
      const focusTarget = restoreOriginalPosition
        ? searchRestoreFocusRef.current
        : null;
      searchOriginalScrollTopRef.current = null;
      searchRestoreFocusRef.current = null;

      if (restoreOriginalPosition || focusTarget) {
        requestAnimationFrame(() => {
          const scrollContainer = containerRef.current?.parentElement;
          if (scrollContainer && scrollTopToRestore !== null) {
            scrollContainer.scrollTop = scrollTopToRestore;
          }
          if (focusTarget?.isConnected) {
            focusTarget.focus({ preventScroll: true });
          }
        });
      }

      setUserTurnSearch((previous) => {
        return {
          active: false,
          scope: previous.scope,
          query: "",
          caseSensitive: false,
          selectedId: null,
          originalScrollTop: null,
        };
      });
    },
    [containerRef],
  );
  const openSearch = useCallback(
    (scope: SessionIsearchScope) => {
      const canSearch =
        scope === "user"
          ? hasUserSearchableTurn
          : displayRenderItems.length > 0;
      if (!canSearch) {
        return;
      }
      const activeElement = document.activeElement;
      searchRestoreFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
      const scrollContainer = containerRef.current?.parentElement;
      searchOriginalScrollTopRef.current = scrollContainer?.scrollTop ?? null;
      committedSearchTargetIdRef.current = null;
      setUserTurnSearch({
        active: true,
        scope,
        query: "",
        caseSensitive: false,
        selectedId: null,
        originalScrollTop: searchOriginalScrollTopRef.current,
      });
      requestAnimationFrame(() => {
        searchInputRef.current?.focus({ preventScroll: true });
        searchInputRef.current?.select();
      });
    },
    [containerRef, hasUserSearchableTurn, displayRenderItems.length],
  );
  const handleQueryChange = useCallback((query: string) => {
    committedSearchTargetIdRef.current = null;
    setUserTurnSearch((previous) => ({
      ...previous,
      query,
      selectedId: null,
    }));
  }, []);
  const toggleCaseSensitive = useCallback(() => {
    committedSearchTargetIdRef.current = null;
    setUserTurnSearch((previous) =>
      previous.active
        ? {
            ...previous,
            caseSensitive: !previous.caseSensitive,
            selectedId: null,
          }
        : previous,
    );
  }, []);
  const getSelectedSearchTargetId = useCallback(
    () => selectedSearchTargetIdRef.current,
    [],
  );

  useLayoutEffect(() => {
    if (!userTurnSearch.active) {
      stopSearchArrowRepeat();
      return;
    }
    setUserTurnSearch((previous) => {
      if (!previous.active) {
        return previous;
      }
      let nextSelectedId: string | null = null;
      if (searchReady && userTurnSearchMatches.length > 0) {
        nextSelectedId =
          previous.selectedId && userTurnSearchMatchIds.has(previous.selectedId)
            ? previous.selectedId
            : (userTurnSearchMatches[userTurnSearchMatches.length - 1]?.id ??
              null);
      }
      if (previous.selectedId === nextSelectedId) {
        return previous;
      }
      return { ...previous, selectedId: nextSelectedId };
    });
  }, [
    searchReady,
    stopSearchArrowRepeat,
    userTurnSearch.active,
    userTurnSearchMatches,
    userTurnSearchMatchIds,
  ]);

  useLayoutEffect(() => {
    if (!userTurnSearch.active || !committedSearchTargetIdRef.current) {
      return;
    }
    const retainedTargetIds = new Set(
      userTurnSearchMatches.map((anchor) => anchor.targetId ?? anchor.id),
    );
    if (!retainedTargetIds.has(committedSearchTargetIdRef.current)) {
      committedSearchTargetIdRef.current = null;
    }
  }, [userTurnSearch.active, userTurnSearchMatches]);

  useEffect(() => {
    if (inert) {
      stopSearchArrowRepeat();
    }
  }, [inert, stopSearchArrowRepeat]);

  const searchPanelTarget =
    userTurnSearch.active && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(".session-input-inner")
      : null;
  const searchPanel = userTurnSearch.active ? (
    <div className={styles.panel} role="search">
      <div className={styles.main}>
        <span className={styles.label}>{searchPanelProjection.scopeLabel}</span>
        <input
          ref={searchInputRef}
          className={styles.input}
          value={userTurnSearch.query}
          onChange={(event) => handleQueryChange(event.target.value)}
          placeholder="reverse search"
          aria-label={searchPanelProjection.scopeAriaLabel}
        />
        <button
          type="button"
          className={[
            styles.caseToggle,
            userTurnSearch.caseSensitive ? styles.active : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-label="Case-sensitive search"
          aria-pressed={userTurnSearch.caseSensitive}
          title={
            userTurnSearch.caseSensitive
              ? "Case-sensitive search on"
              : "Case-sensitive search off"
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleCaseSensitive}
        >
          Aa
        </button>
        <span className={styles.count}>{searchPanelProjection.countLabel}</span>
      </div>
      <div className={styles.help}>
        <span>
          {t("sessionSearchHelpNavigate", {
            shortcutKeys: searchPanelProjection.shortcutKeys,
          })}
        </span>
        <span>{t("sessionSearchHelpClose")}</span>
      </div>
    </div>
  ) : null;
  const portaledSearchPanel =
    searchPanelTarget && searchPanel
      ? createPortal(searchPanel, searchPanelTarget)
      : searchPanel;

  return {
    active: userTurnSearch.active,
    scope: userTurnSearch.scope,
    visibleTurnGroups,
    getNavigatorAnchors,
    searchState,
    searchPanel: portaledSearchPanel,
    closeSearch,
    getSelectedSearchTargetId,
    handleSearchArrowKey,
    moveSearchSelection,
    openSearch,
    selectSearchMatch,
    stopSearchArrowRepeat,
  };
}
