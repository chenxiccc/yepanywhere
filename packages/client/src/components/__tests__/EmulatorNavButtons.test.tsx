import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmulatorNavButtons } from "../EmulatorNavButtons";

function createDataChannel() {
  return {
    readyState: "open",
    send: vi.fn(),
  } as unknown as RTCDataChannel;
}

describe("EmulatorNavButtons", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Android navigation controls for Android devices", () => {
    const dataChannel = createDataChannel();

    render(
      <EmulatorNavButtons dataChannel={dataChannel} deviceType="android" />,
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Home" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Recents" })).toBeDefined();
  });

  it("sends the Android key message for each navigation button", () => {
    const dataChannel = createDataChannel();

    render(
      <EmulatorNavButtons dataChannel={dataChannel} deviceType="emulator" />,
    );

    for (const [name, key] of [
      ["Back", "GoBack"],
      ["Home", "GoHome"],
      ["Recents", "AppSwitch"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(dataChannel.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "key", key }),
      );
    }
  });

  it("disables the buttons and sends nothing until the channel opens", () => {
    const dataChannel = {
      readyState: "connecting",
      send: vi.fn(),
    } as unknown as RTCDataChannel;

    render(
      <EmulatorNavButtons dataChannel={dataChannel} deviceType="android" />,
    );

    const home = screen.getByRole("button", { name: "Home" });
    expect(home.hasAttribute("disabled")).toBe(true);

    fireEvent.click(home);
    expect(dataChannel.send).not.toHaveBeenCalled();
  });

  it("disables the buttons when there is no data channel", () => {
    render(<EmulatorNavButtons dataChannel={null} deviceType="ios-simulator" />);

    expect(
      screen.getByRole("button", { name: "Home" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("styles the root and buttons from the co-located CSS Module", () => {
    const dataChannel = createDataChannel();
    const { container } = render(
      <EmulatorNavButtons dataChannel={dataChannel} deviceType="android" />,
    );

    const root = container.firstElementChild as HTMLElement;
    const buttons = Array.from(root.querySelectorAll("button"));

    expect(root.className).not.toBe("");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.className).not.toBe("");
      expect(button.className).not.toBe(root.className);
    }

    const markup = container.innerHTML;
    expect(markup).not.toContain("emulator-nav-buttons");
    expect(markup).not.toContain("emulator-nav-btn");
  });

  it("renders only Home for iOS simulators and sends GoHome", () => {
    const dataChannel = createDataChannel();

    render(
      <EmulatorNavButtons
        dataChannel={dataChannel}
        deviceType="ios-simulator"
      />,
    );

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Home" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Recents" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(dataChannel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "key", key: "GoHome" }),
    );
  });

  it("renders nothing for unsupported device types", () => {
    const dataChannel = createDataChannel();
    const { container } = render(
      <EmulatorNavButtons dataChannel={dataChannel} deviceType="chromeos" />,
    );

    expect(container.firstChild).toBeNull();
  });
});
