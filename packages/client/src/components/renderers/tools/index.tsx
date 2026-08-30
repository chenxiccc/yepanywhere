import type { ReactNode } from "react";
import { canonicalizeToolName } from "../../../lib/toolNames";
import type { ToolCallItem } from "../../../types/renderItems";
import type { RenderContext } from "../types";
import type { ToolRenderer } from "./types";

/**
 * Registry for tool-specific renderers
 */
class ToolRendererRegistry {
  private tools = new Map<string, ToolRenderer>();
  private fallback: ToolRenderer;

  constructor(fallback: ToolRenderer) {
    this.fallback = fallback;
  }

  register(renderer: ToolRenderer): void {
    this.tools.set(renderer.tool, renderer);
  }

  get(toolName: string): ToolRenderer {
    const canonicalToolName = canonicalizeToolName(toolName);
    return this.tools.get(canonicalToolName) || this.fallback;
  }

  renderToolUse(
    toolName: string,
    input: unknown,
    context: RenderContext,
  ): ReactNode {
    return this.get(toolName).renderToolUse(input, context);
  }

  renderToolResult(
    toolName: string,
    result: unknown,
    isError: boolean,
    context: RenderContext,
    input?: unknown,
  ): ReactNode {
    return this.get(toolName).renderToolResult(result, isError, context, input);
  }

  hasInteractiveSummary(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderInteractiveSummary === "function";
  }

  hasCollapsedPreview(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderCollapsedPreview === "function";
  }

  renderCollapsedPreview(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderCollapsedPreview) {
      return renderer.renderCollapsedPreview(input, result, isError, context);
    }
    return null;
  }

  renderInteractiveSummary(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderInteractiveSummary) {
      return renderer.renderInteractiveSummary(input, result, isError, context);
    }
    return null;
  }

  hasInlineRenderer(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderInline === "function";
  }

  renderInline(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    status: ToolCallItem["status"],
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderInline) {
      return renderer.renderInline(input, result, isError, status, context);
    }
    return null;
  }

  getDisplayName(
    toolName: string,
    status?: ToolCallItem["status"],
    input?: unknown,
  ): string {
    const renderer = this.get(toolName);
    if (input !== undefined && renderer.displayNameForCall) {
      const dynamicName = renderer.displayNameForCall(
        input,
        status ?? "complete",
      );
      if (dynamicName) {
        return dynamicName;
      }
    }
    if (status === "pending" && renderer.pendingDisplayName) {
      return renderer.pendingDisplayName;
    }
    return renderer.displayName || toolName;
  }
}

/**
 * Fallback tool renderer - shows raw JSON
 */
const fallbackToolRenderer: ToolRenderer = {
  tool: "__fallback__",
  renderToolUse(input, _context) {
    return (
      <pre className="tool-fallback">
        <code>{JSON.stringify(input, null, 2)}</code>
      </pre>
    );
  },
  renderToolResult(result, isError, _context) {
    return (
      <pre className={`tool-fallback ${isError ? "tool-fallback-error" : ""}`}>
        <code>{JSON.stringify(result, null, 2)}</code>
      </pre>
    );
  },
};

// Create and export the tool registry
export const toolRegistry = new ToolRendererRegistry(fallbackToolRenderer);

// Import and register tool renderers
import { askUserQuestionRenderer } from "./AskUserQuestionRenderer";
import { bashOutputRenderer } from "./BashOutputRenderer";
import { bashRenderer } from "./BashRenderer";
import { codeModeExecRenderer } from "./CodeModeExecRenderer";
import { editRenderer } from "./EditRenderer";
import { exitPlanModeRenderer } from "./ExitPlanModeRenderer";
import { globRenderer } from "./GlobRenderer";
import {
  createGoalToolRenderer,
  getGoalToolRenderer,
  updateGoalToolRenderer,
} from "./GoalRenderer";
import { grepRenderer } from "./GrepRenderer";
import { killShellRenderer } from "./KillShellRenderer";
import { readRenderer } from "./ReadRenderer";
import { spawnAgentRenderer } from "./SpawnAgentRenderer";
import { taskOutputRenderer } from "./TaskOutputRenderer";
import { taskCreateRenderer, taskUpdateRenderer } from "./TaskListRenderer";
import { taskRenderer } from "./TaskRenderer";
import { todoWriteRenderer } from "./TodoWriteRenderer";
import { updatePlanRenderer } from "./UpdatePlanRenderer";
import { viewImageRenderer } from "./ViewImageRenderer";
import { webFetchRenderer } from "./WebFetchRenderer";
import { webRenderer } from "./WebRenderer";
import { webSearchRenderer } from "./WebSearchRenderer";
import { writeRenderer } from "./WriteRenderer";
import { writeStdinRenderer } from "./WriteStdinRenderer";

// Tier 1 & 2: Core tools
toolRegistry.register(bashRenderer);
toolRegistry.register(readRenderer);
toolRegistry.register(editRenderer);
toolRegistry.register(writeRenderer);
toolRegistry.register(globRenderer);
toolRegistry.register(grepRenderer);
toolRegistry.register(todoWriteRenderer);
toolRegistry.register(taskCreateRenderer);
toolRegistry.register(taskUpdateRenderer);

// Tier 3: Less common tools
toolRegistry.register(taskRenderer);
toolRegistry.register(webSearchRenderer);
toolRegistry.register(webFetchRenderer);
toolRegistry.register(webRenderer);
toolRegistry.register(askUserQuestionRenderer);
toolRegistry.register(exitPlanModeRenderer);
toolRegistry.register(updatePlanRenderer);
toolRegistry.register(writeStdinRenderer);

// Codex-specific tools
toolRegistry.register(createGoalToolRenderer);
toolRegistry.register(getGoalToolRenderer);
toolRegistry.register(updateGoalToolRenderer);
toolRegistry.register(viewImageRenderer);
toolRegistry.register(spawnAgentRenderer);
toolRegistry.register(codeModeExecRenderer);

// Tier 4: Background/async tools
toolRegistry.register(bashOutputRenderer);
toolRegistry.register(taskOutputRenderer);
toolRegistry.register(killShellRenderer);
