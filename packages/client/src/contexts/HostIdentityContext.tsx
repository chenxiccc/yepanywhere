import {
  HOST_IDENTITY_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useServerSettings } from "../hooks/useServerSettings";
import { useVersion } from "../hooks/useVersion";

interface HostIdentityContextValue {
  supported: boolean;
  icon: string | null;
}

const HostIdentityContext = createContext<HostIdentityContextValue>({
  supported: false,
  icon: null,
});

export function HostIdentityProvider({ children }: { children: ReactNode }) {
  const { version } = useVersion();
  const { settings } = useServerSettings();
  const supported = serverHasCapability(version, HOST_IDENTITY_CAPABILITY);
  const value = useMemo<HostIdentityContextValue>(
    () => ({
      supported,
      icon: supported ? (settings?.hostIdentity?.icon ?? null) : null,
    }),
    [settings?.hostIdentity?.icon, supported],
  );

  return (
    <HostIdentityContext.Provider value={value}>
      {children}
    </HostIdentityContext.Provider>
  );
}

export function useHostIdentity(): HostIdentityContextValue {
  return useContext(HostIdentityContext);
}
