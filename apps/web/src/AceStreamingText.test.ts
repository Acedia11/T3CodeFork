import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AttachAceStreamingText } from "./AceStreamingText";

class TestText {
  data = "Read";
  nodeType = 3;
  Attributes = new Map<string, string>();
  parentElement = {
    setAttribute: (Name: string, Value: string) => this.Attributes.set(Name, Value),
    removeAttribute: (Name: string) => this.Attributes.delete(Name),
  };
  get length() {
    return this.data.length;
  }
}

class TestRange {
  Start = 0;
  End = 0;
  Node: TestText | undefined;
  get startContainer() {
    return this.Node;
  }
  setStart(Node: TestText, Offset: number) {
    this.Node = Node;
    this.Start = Offset;
  }
  setEnd(_Node: TestText, Offset: number) {
    this.End = Offset;
  }
  toString() {
    return this.Node?.data.slice(this.Start, this.End) ?? "";
  }
}

const Cleanups: Array<() => void> = [];

function CreateStream() {
  let Now = 0;
  let NextFrame = 0;
  let Reads = 0;
  let Identity = "message-one";
  const Text = new TestText();
  const Frames = new Map<number, FrameRequestCallback>();
  const Highlights = new Map<string, Set<TestRange>>();
  const Motion = Object.assign(new EventTarget(), { matches: false });
  const Observers = new Set<TestObserver>();
  class TestObserver {
    constructor(readonly Callback: MutationCallback) {}
    observe() {
      Observers.add(this);
    }
    disconnect() {
      Observers.delete(this);
    }
  }
  const Document = Object.assign(new EventTarget(), {
    hidden: false,
    createRange: () => new TestRange(),
    createTreeWalker() {
      Reads += 1;
      let Visited = false;
      return {
        nextNode() {
          if (Visited) return null;
          Visited = true;
          return Text;
        },
      };
    },
  });
  const Root = {
    ownerDocument: Document,
    isConnected: true,
    closest: () => ({ getAttribute: () => Identity }),
  };
  vi.stubGlobal("window", { matchMedia: () => Motion });
  vi.stubGlobal("performance", { now: () => Now });
  vi.stubGlobal("MutationObserver", TestObserver);
  vi.stubGlobal("NodeFilter", { SHOW_ELEMENT: 1, SHOW_TEXT: 4 });
  vi.stubGlobal("CSS", { highlights: Highlights, supports: () => true });
  vi.stubGlobal(
    "Highlight",
    class extends Set<TestRange> {
      priority = 0;
    },
  );
  vi.stubGlobal("requestAnimationFrame", (Callback: FrameRequestCallback) => {
    Frames.set(++NextFrame, Callback);
    return NextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (Frame: number) => Frames.delete(Frame));
  const Stream = AttachAceStreamingText(Root as unknown as HTMLElement, "thread-one")!;
  Cleanups.push(Stream.Dispose);
  return {
    Stream,
    Document,
    Motion,
    Observers,
    Frames,
    Reads: () => Reads,
    HasFadeStyles: () => Text.Attributes.has("data-ace-text-fade"),
    ChangeIdentity: () => (Identity = "message-two"),
    Append(Value: string, Time: number, Deliver = true) {
      Now = Time;
      Text.data += Value;
      if (Deliver) {
        for (const Observer of Observers) {
          Observer.Callback([], Observer as unknown as MutationObserver);
        }
      }
    },
    Paint(Time: number) {
      Now = Time;
      const Callbacks = [...Frames.values()];
      Frames.clear();
      for (const Callback of Callbacks) Callback(Time);
    },
    Painted: () =>
      [...Highlights].flatMap(([Name, Ranges]) =>
        [...Ranges].map((Range) => ({
          Text: Range.toString(),
          Level: Number(Name.slice("AceStreaming".length)),
        })),
      ),
  };
}

afterEach(() => {
  for (const Cleanup of Cleanups.splice(0)) Cleanup();
  vi.unstubAllGlobals();
});

describe("stream completion", () => {
  it("captures a final append in the completion commit and drains without restarting earlier text", () => {
    const View = CreateStream();
    View.Stream.SetStreaming(true);
    View.Append(" this", 20);
    View.Append(" now", 100, false);
    View.Stream.SetStreaming(false);

    expect(View.HasFadeStyles()).toBe(true);
    expect(View.Observers.size).toBe(0);
    expect(View.Painted()).toEqual([
      { Text: " this", Level: expect.any(Number) },
      { Text: " now", Level: 0 },
    ]);
    expect(View.Painted()[0]!.Level).toBeGreaterThan(0);
    View.Paint(420);
    expect(View.Painted()).toEqual([{ Text: " now", Level: expect.any(Number) }]);
    View.Paint(500);
    expect(View.Painted()).toEqual([]);
    expect(View.Frames.size).toBe(0);
    expect(View.HasFadeStyles()).toBe(false);

    const Reads = View.Reads();
    View.Append(" settled history", 600);
    expect(View.Reads()).toBe(Reads);
    expect(View.Painted()).toEqual([]);
  });

  it("does not observe or scan an inactive message", () => {
    const View = CreateStream();
    View.Stream.SetStreaming(false);
    View.Document.dispatchEvent(new Event("visibilitychange"));
    expect(View.Observers.size).toBe(0);
    expect(View.Reads()).toBe(0);
    expect(View.HasFadeStyles()).toBe(false);
    expect(View.Frames.size).toBe(0);
  });

  it("clears a draining message immediately when disposed", () => {
    const View = CreateStream();
    View.Stream.SetStreaming(true);
    View.Append(" this", 20);
    View.Stream.SetStreaming(false);
    expect(View.Painted().length).toBeGreaterThan(0);
    View.Stream.Dispose();
    expect(View.HasFadeStyles()).toBe(false);
    expect(View.Painted()).toEqual([]);
    expect(View.Frames.size).toBe(0);
    View.Stream.SetStreaming(true);
    expect(View.Observers.size).toBe(0);
    expect(View.HasFadeStyles()).toBe(false);
  });

  it.each(["hidden", "reduced motion"])("clears a draining message for %s", (Condition) => {
    const View = CreateStream();
    View.Stream.SetStreaming(true);
    View.Append(" this", 20);
    View.Stream.SetStreaming(false);
    if (Condition === "hidden") {
      View.Document.hidden = true;
      View.Document.dispatchEvent(new Event("visibilitychange"));
    } else {
      View.Motion.matches = true;
      View.Motion.dispatchEvent(new Event("change"));
    }
    expect(View.Painted()).toEqual([]);
    expect(View.Frames.size).toBe(0);
    expect(View.Observers.size).toBe(0);
  });

  it("clears pending ranges before painting a recycled message", () => {
    const View = CreateStream();
    View.Stream.SetStreaming(true);
    View.Append(" this", 20);
    View.Stream.SetStreaming(false);
    View.ChangeIdentity();
    View.Paint(40);
    expect(View.HasFadeStyles()).toBe(false);
    expect(View.Painted()).toEqual([]);
    expect(View.Frames.size).toBe(0);
  });
});
