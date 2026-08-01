export function Widget({ tone }: { tone: string }) {
  return (
    <section className="widget-root active host shared-surface">
      <h2 className="widget-title">Widget</h2>
      <span className={`widget-tone-${tone}`} />
    </section>
  );
}
