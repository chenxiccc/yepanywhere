export function Widget({ tone }: { tone: string }) {
  const status = "status";
  return (
    <section
      className="widget-root active host shared-surface"
      data-status={status}
    >
      <h2 className="widget-title">Widget</h2>
      <span className={`widget-tone-${tone}`} />
    </section>
  );
}
