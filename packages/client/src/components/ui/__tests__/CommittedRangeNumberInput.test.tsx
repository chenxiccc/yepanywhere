// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommittedRangeNumberInput } from "../CommittedRangeNumberInput";

afterEach(cleanup);

describe("CommittedRangeNumberInput", () => {
  it("shares slider drafts with the number and commits on release", () => {
    const onEdit = vi.fn();
    const onCommit = vi.fn();
    render(
      <CommittedRangeNumberInput
        min={0}
        max={100}
        step={10}
        value={50}
        unit="ms"
        ariaLabel="Delay"
        onEdit={onEdit}
        onCommit={onCommit}
      />,
    );

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "Delay",
    });
    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Delay",
    });
    fireEvent.change(slider, { target: { value: "70" } });

    expect(number.value).toBe("70");
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledWith(70);
  });

  it("does not treat an empty number draft as an edit or commit", () => {
    const onEdit = vi.fn();
    const onCommit = vi.fn();
    render(
      <CommittedRangeNumberInput
        min={0}
        max={100}
        value={50}
        ariaLabel="Delay"
        onEdit={onEdit}
        onCommit={onCommit}
      />,
    );

    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Delay",
    });
    fireEvent.change(number, { target: { value: "" } });

    expect(number.value).toBe("");
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.blur(number);
    expect(number.value).toBe("50");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("selects the edit path for valid number drafts and normalizes on blur", () => {
    const onEdit = vi.fn();
    const onCommit = vi.fn();
    render(
      <CommittedRangeNumberInput
        min={0}
        max={100}
        step={10}
        value={50}
        ariaLabel="Delay"
        onEdit={onEdit}
        onCommit={onCommit}
      />,
    );

    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Delay",
    });
    fireEvent.change(number, { target: { value: "77" } });
    expect(onEdit).toHaveBeenCalledOnce();
    fireEvent.blur(number);

    expect(onCommit).toHaveBeenCalledWith(80);
    expect(number.value).toBe("80");
  });

  it("normalizes steps relative to a nonzero minimum", () => {
    const onCommit = vi.fn();
    render(
      <CommittedRangeNumberInput
        min={5}
        max={95}
        step={10}
        value={55}
        ariaLabel="Offset range"
        onCommit={onCommit}
      />,
    );

    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Offset range",
    });
    fireEvent.change(number, { target: { value: "77" } });
    fireEvent.blur(number);

    expect(onCommit).toHaveBeenCalledWith(75);
  });

  it("allows free number values beyond the slider range", () => {
    const onCommit = vi.fn();
    const { container } = render(
      <CommittedRangeNumberInput
        min={85}
        max={130}
        numberMin={50}
        numberMax={300}
        step={5}
        list="scale-notches"
        value={300}
        unit="%"
        ariaLabel="UI size"
        snapTextToStep={false}
        onCommit={onCommit}
      />,
    );

    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: "UI size",
    });
    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "UI size",
    });
    expect(slider.value).toBe("130");
    expect(slider.getAttribute("list")).toBe("scale-notches");
    expect(number.value).toBe("300");
    expect(number.step).toBe("any");

    fireEvent.change(number, { target: { value: "93.5" } });
    fireEvent.blur(number);
    expect(onCommit).toHaveBeenCalledWith(93.5);

    fireEvent.change(number, { target: { value: "20" } });
    fireEvent.blur(number);
    expect(onCommit).toHaveBeenLastCalledWith(50);
    expect(slider.value).toBe("85");
    expect(container.textContent).toContain("%");
  });
});
