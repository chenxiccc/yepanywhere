import { createContext, type ReactNode, useContext } from "react";
import type { YaSourceRuntime } from "./sourceRuntime";

const SourceRuntimeContext = createContext<YaSourceRuntime | null>(null);

interface SourceRuntimeProviderProps {
  children: ReactNode;
  runtime: YaSourceRuntime;
}

export function SourceRuntimeProvider({
  children,
  runtime,
}: SourceRuntimeProviderProps) {
  return (
    <SourceRuntimeContext.Provider value={runtime}>
      {children}
    </SourceRuntimeContext.Provider>
  );
}

export function useSourceRuntimeContextValue(): YaSourceRuntime | null {
  return useContext(SourceRuntimeContext);
}
