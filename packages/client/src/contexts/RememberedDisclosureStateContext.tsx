import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";

const KEY_SEPARATOR = "\u0000";

function stateKey(ownerId: string, controlId: string): string {
  return [ownerId, controlId].join(KEY_SEPARATOR);
}

function ownerIdFromStateKey(key: string): string {
  const separatorIndex = key.indexOf(KEY_SEPARATOR);
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

export interface RememberedDisclosureStateRegistry {
  readonly size: number;
  read(
    ownerId: string,
    controlId: string,
    defaultExpanded: boolean,
  ): { expanded: boolean; overridden: boolean };
  write(
    ownerId: string,
    controlId: string,
    defaultExpanded: boolean,
    expanded: boolean,
  ): void;
  pruneOwners(loadedOwnerIds: ReadonlySet<string>): void;
}

export function createRememberedDisclosureStateRegistry(): RememberedDisclosureStateRegistry {
  const explicitStates = new Map<string, boolean>();

  return {
    get size() {
      return explicitStates.size;
    },
    read(ownerId, controlId, defaultExpanded) {
      const explicitState = explicitStates.get(stateKey(ownerId, controlId));
      return explicitState === undefined
        ? { expanded: defaultExpanded, overridden: false }
        : { expanded: explicitState, overridden: true };
    },
    write(ownerId, controlId, defaultExpanded, expanded) {
      const key = stateKey(ownerId, controlId);
      if (expanded === defaultExpanded) {
        explicitStates.delete(key);
      } else {
        explicitStates.set(key, expanded);
      }
    },
    pruneOwners(loadedOwnerIds) {
      for (const key of explicitStates.keys()) {
        if (!loadedOwnerIds.has(ownerIdFromStateKey(key))) {
          explicitStates.delete(key);
        }
      }
    },
  };
}

const RememberedDisclosureStateContext =
  createContext<RememberedDisclosureStateRegistry | null>(null);

export function RememberedDisclosureStateProvider({
  children,
  registry,
}: {
  children?: ReactNode;
  registry: RememberedDisclosureStateRegistry;
}) {
  return (
    <RememberedDisclosureStateContext.Provider value={registry}>
      {children}
    </RememberedDisclosureStateContext.Provider>
  );
}

export function useRememberedDisclosureState(
  ownerId: string,
  controlId: string,
  defaultExpanded: boolean,
): [
  expanded: boolean,
  setExpanded: Dispatch<SetStateAction<boolean>>,
  initiallyOverridden: boolean,
] {
  const registry = useContext(RememberedDisclosureStateContext);
  const [initial] = useState(
    () =>
      registry?.read(ownerId, controlId, defaultExpanded) ?? {
        expanded: defaultExpanded,
        overridden: false,
      },
  );
  const [expanded, setLocalExpanded] = useState(initial.expanded);
  const setExpanded = useCallback<Dispatch<SetStateAction<boolean>>>(
    (update) => {
      setLocalExpanded((current) => {
        const next = typeof update === "function" ? update(current) : update;
        registry?.write(ownerId, controlId, defaultExpanded, next);
        return next;
      });
    },
    [controlId, defaultExpanded, ownerId, registry],
  );

  return [expanded, setExpanded, initial.overridden];
}
