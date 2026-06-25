import { memo } from "react";

/** 从 diff 行中渲染行内差异 / Render inline diff from diff lines */
export const DiffLines = memo(function DiffLines({
  lines,
}: {
  lines: string[];
}) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, index) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${index}-${line.slice(0, 50)}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});