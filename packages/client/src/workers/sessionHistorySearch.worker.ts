/// <reference lib="webworker" />

import {
  searchSessionHistoryPage,
  type SessionHistorySearchWorkerRequest,
  type SessionHistorySearchWorkerResponse,
} from "../lib/sessionHistorySearch";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener(
  "message",
  (event: MessageEvent<SessionHistorySearchWorkerRequest>) => {
    const { requestId, ...input } = event.data;
    const result: SessionHistorySearchWorkerResponse = {
      requestId,
      ...searchSessionHistoryPage(input),
    };
    workerScope.postMessage(result);
  },
);
