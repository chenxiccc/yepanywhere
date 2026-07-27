import type {
  ProviderName,
  ReviewNewSessionOptions,
} from "@yep-anywhere/shared";
import { createContext, useContext } from "react";

/**
 * Session that opened this Source Control history entry. Kept in browser
 * history state so activity in other tabs or devices cannot retarget review.
 */
export interface SourceReviewDefaultSession {
  projectId: string;
  id: string;
  title: string;
  newSession: ReviewNewSessionOptions & { provider: ProviderName };
}

export const SourceReviewDefaultSessionContext =
  createContext<SourceReviewDefaultSession | null>(null);

export function useSourceReviewDefaultSession(): SourceReviewDefaultSession | null {
  return useContext(SourceReviewDefaultSessionContext);
}
