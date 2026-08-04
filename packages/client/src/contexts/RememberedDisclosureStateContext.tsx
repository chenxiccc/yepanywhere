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

function stateKey(
  ownerId: string,
  controlId: string,
  defaultExpanded: boolean,
): string {
  return [ownerId, controlId, defaultExpanded ? "1" : "0"].join(KEY_SEPARATOR);
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
  const toggled = new Set<string>();

  return {
    get size() {
      return toggled.size;
    },
    read(ownerId, controlId, defaultExpanded) {
      const currentDefaultKey = stateKey(ownerId, controlId, defaultExpanded);
      const previousDefaultKey = stateKey(ownerId, controlId, !defaultExpanded);
      if (toggled.has(currentDefaultKey)) {
        return { expanded: !defaultExpanded, overridden: true };
      }

      // A remembered value opposite the prior default now equals the current
      // default. Drop it instead of retaining a redundant entry.
      toggled.delete(previousDefaultKey);
      return { expanded: defaultExpanded, overridden: false };
    },
    write(ownerId, controlId, defaultExpanded, expanded) {
      toggled.delete(stateKey(ownerId, controlId, defaultExpanded));
      toggled.delete(stateKey(ownerId, controlId, !defaultExpanded));
      if (expanded !== defaultExpanded) {
        toggled.add(stateKey(ownerId, controlId, defaultExpanded));
      }
    },
    pruneOwners(loadedOwnerIds) {
      for (const key of toggled) {
        if (!loadedOwnerIds.has(ownerIdFromStateKey(key))) {
          toggled.delete(key);
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
