import { act, useEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AceToolDisclosure } from "./AceToolDisclosure";

let Renderer: ReactTestRenderer | undefined;
let Motion = Object.assign(new EventTarget(), { matches: false });
let Mounts = 0;
let Unmounts = 0;

function Content() {
  const [Value, SetValue] = useState(0);
  useEffect(() => {
    Mounts += 1;
    return () => {
      Unmounts += 1;
    };
  }, []);
  return <button onClick={() => SetValue(Value + 1)}>{Value}</button>;
}

async function Render(Open: boolean) {
  await act(() => {
    const View = <AceToolDisclosure Open={Open} Id="tool-details" Children={<Content />} />;
    if (Renderer) Renderer.update(View);
    else Renderer = create(View);
  });
}

async function Advance(Milliseconds: number) {
  await act(() => {
    vi.advanceTimersByTime(Milliseconds);
  });
}

async function TransitionEnd(Property = "grid-template-rows", Nested = false) {
  const Target = {};
  const Fold = Renderer!.root.findByProps({ className: "AceToolFold" });
  const Props = Fold.props as {
    onTransitionEnd(Event: { target: object; currentTarget: object; propertyName: string }): void;
  };
  await act(() => {
    Props.onTransitionEnd({
      target: Nested ? {} : Target,
      currentTarget: Target,
      propertyName: Property,
    });
  });
}

beforeEach(() => {
  Mounts = Unmounts = 0;
  Motion = Object.assign(new EventTarget(), { matches: false });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { matchMedia: () => Motion });
});

afterEach(async () => {
  await act(() => Renderer?.unmount());
  Renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("tool disclosure lifetime", () => {
  it("unmounts a closed group even if its transition never emits an end event", async () => {
    await Render(true);
    await Render(false);
    expect(Unmounts).toBe(0);
    await Advance(100);
    expect(Unmounts).toBe(0);
    await Advance(150);
    expect(Unmounts).toBe(1);
    expect(Renderer!.root.findAllByType("button")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves mounted content and its state when a close is quickly reversed", async () => {
    await Render(true);
    const Button = Renderer!.root.findByType("button");
    await act(() => (Button.props as { onClick(): void }).onClick());
    await Render(false);
    await Advance(80);
    await Render(true);
    await Advance(500);
    expect(Mounts).toBe(1);
    expect(Unmounts).toBe(0);
    expect(Renderer!.root.findByType("button").children).toEqual(["1"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for its own grid transition and ignores child or opacity events", async () => {
    await Render(true);
    await Render(false);
    await TransitionEnd("opacity");
    await TransitionEnd("grid-template-rows", true);
    expect(Unmounts).toBe(0);
    await TransitionEnd();
    expect(Unmounts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles immediately when reduced motion turns on during a close", async () => {
    await Render(true);
    await Render(false);
    await act(() => {
      Motion.matches = true;
      Motion.dispatchEvent(new Event("change"));
    });
    expect(Unmounts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await Render(true);
    await Render(false);
    expect(Mounts).toBe(2);
    expect(Unmounts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases its close fallback when the virtualized group unmounts", async () => {
    await Render(true);
    await Render(false);
    expect(vi.getTimerCount()).toBe(1);
    await act(() => Renderer!.unmount());
    Renderer = undefined;
    expect(Unmounts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
