function cachedModule<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    promise ??= load();
    return promise;
  };
}

export const loadMessageListModule = cachedModule(
  () => import("../components/MessageList"),
);

export const loadMessageInputModule = cachedModule(
  () => import("../components/MessageInput"),
);

export function loadSessionCoreModules(): Promise<unknown> {
  return Promise.all([loadMessageListModule(), loadMessageInputModule()]);
}
