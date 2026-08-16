import { useCallback, useMemo, useState } from "react";
import { getCachedWebTranscriptProjection } from "../../../lib/webTranscriptProjection";
import type { Message } from "../../../types";
import { RenderItemComponent } from "../../RenderItemComponent";

export function TaskNestedContent({
  messages,
  isStreaming,
}: {
  messages: Message[];
  isStreaming: boolean;
}) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const toggleThinkingExpanded = useCallback(() => {
    setThinkingExpanded((prev) => !prev);
  }, []);

  const renderItems = useMemo(
    () => getCachedWebTranscriptProjection(messages),
    [messages],
  );

  return (
    <div className="task-nested-content">
      {renderItems.map((item) => (
        <RenderItemComponent
          key={item.id}
          item={item}
          isStreaming={isStreaming}
          thinkingExpanded={thinkingExpanded}
          toggleThinkingExpanded={toggleThinkingExpanded}
        />
      ))}
    </div>
  );
}
