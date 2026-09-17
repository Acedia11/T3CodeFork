import { AceStreamingFade, AceStreamingOpacity, type AceStreamingChunk } from "./AceStreamingFade";
import "./AceStreamingText.css";

const Levels = 32;
const Excluded =
  "button, input, textarea, select, [role=button], [role=toolbar], [contenteditable], [hidden], [aria-hidden=true]:not(pre), script, style, template, noscript, svg, .chat-markdown-codeblock-header, .select-none";

interface TextSpan {
  Node: Text;
  Start: number;
  End: number;
}

interface PaintedChunk {
  Chunk: AceStreamingChunk;
  Ranges: Range[];
  Level: number;
}

function ReadText(Root: HTMLElement) {
  const Nodes: TextSpan[] = [];
  const Parts: string[] = [];
  let Length = 0;
  const Walker = Root.ownerDocument.createTreeWalker(
    Root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(Node) {
        if (Node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        return (Node as Element).matches(Excluded)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  for (let Node = Walker.nextNode() as Text | null; Node; Node = Walker.nextNode() as Text | null) {
    if (Node.length === 0) continue;
    Nodes.push({ Node, Start: Length, End: Length + Node.length });
    Parts.push(Node.data);
    Length += Node.length;
  }
  return { Text: Parts.join(""), Nodes };
}

function MoveHighlight(Painted: PaintedChunk, Level: number) {
  if (Painted.Level === Level) return;
  if (Painted.Level >= 0) {
    const Name = `AceStreaming${Painted.Level}`;
    const Previous = CSS.highlights.get(Name);
    for (const Range of Painted.Ranges) Previous?.delete(Range);
    if (Previous?.size === 0) CSS.highlights.delete(Name);
  }
  if (Level >= 0) {
    const Name = `AceStreaming${Level}`;
    let Next = CSS.highlights.get(Name);
    if (!Next) {
      Next = new Highlight();
      Next.priority = -1;
      CSS.highlights.set(Name, Next);
    }
    for (const Range of Painted.Ranges) Next.add(Range);
  }
  Painted.Level = Level;
}

function CreateRanges(Document: Document, Nodes: TextSpan[], Chunk: AceStreamingChunk) {
  let Low = 0;
  let High = Nodes.length;
  while (Low < High) {
    const Middle = (Low + High) >>> 1;
    if (Nodes[Middle]!.End <= Chunk.Start) Low = Middle + 1;
    else High = Middle;
  }
  const Ranges: Range[] = [];
  for (let Index = Low; Index < Nodes.length; Index++) {
    const Span = Nodes[Index]!;
    if (Span.Start >= Chunk.End) break;
    const Range = Document.createRange();
    Range.setStart(Span.Node, Math.max(0, Chunk.Start - Span.Start));
    Range.setEnd(Span.Node, Math.min(Span.Node.length, Chunk.End - Span.Start));
    Ranges.push(Range);
  }
  return Ranges;
}

/** Paint-only ranges leave Markdown structure, selection and clipboard serialization intact. */
export function AttachAceStreamingText(Root: HTMLElement, Scope = "") {
  if (
    typeof Highlight === "undefined" ||
    typeof CSS === "undefined" ||
    !CSS.highlights ||
    !CSS.supports("color", "color-mix(in srgb, currentColor 50%, transparent)")
  ) {
    return;
  }

  const Document = Root.ownerDocument;
  const Motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const Fade = new AceStreamingFade("");
  const ReadIdentity = () =>
    `${Scope}:${Root.closest("[data-assistant-citation-source]")?.getAttribute("data-assistant-citation-source") ?? ""}`;
  let Identity = ReadIdentity();
  let Painted: PaintedChunk[] = [];
  let FadingElements = new Set<Element>();
  let Frame: number | null = null;
  let Streaming = false;
  let Observing = false;
  let Disposed = false;

  function SyncFadingElements() {
    const Next = new Set<Element>();
    for (const Entry of Painted) {
      for (const Range of Entry.Ranges) {
        if (Range.startContainer.parentElement) Next.add(Range.startContainer.parentElement);
      }
    }
    for (const Element of FadingElements) {
      if (!Next.has(Element)) Element.removeAttribute("data-ace-text-fade");
    }
    for (const Element of Next) {
      if (!FadingElements.has(Element)) Element.setAttribute("data-ace-text-fade", "");
    }
    FadingElements = Next;
  }

  function Clear(PreserveFadeStyles = false) {
    if (Frame !== null) cancelAnimationFrame(Frame);
    Frame = null;
    for (const Chunk of Painted) MoveHighlight(Chunk, -1);
    Painted = [];
    if (!PreserveFadeStyles) SyncFadingElements();
  }

  function Paint(Now: number) {
    Frame = null;
    if (!Root.isConnected || ReadIdentity() !== Identity) {
      Clear();
      Fade.Reset(ReadText(Root).Text);
      Identity = ReadIdentity();
      return;
    }
    Painted = Painted.filter((Entry) => {
      const Opacity = AceStreamingOpacity(Entry.Chunk, Now);
      MoveHighlight(Entry, Opacity >= 1 ? -1 : Math.floor(Opacity * Levels));
      return Opacity < 1;
    });
    SyncFadingElements();
    if (Painted.length > 0) Frame = requestAnimationFrame(Paint);
  }

  function Update() {
    if (!Observing || Disposed) return;
    const Current = ReadText(Root);
    const Now = performance.now();
    Clear(true);
    if (ReadIdentity() !== Identity) {
      SyncFadingElements();
      Identity = ReadIdentity();
      Fade.Reset(Current.Text);
      return;
    }
    Painted = Fade.Advance(Current.Text, Now).map((Chunk) => ({
      Chunk,
      Ranges: CreateRanges(Document, Current.Nodes, Chunk),
      Level: -1,
    }));
    Paint(Now);
  }

  const Observer = new MutationObserver(Update);

  function ResetObservation() {
    Observer.disconnect();
    Observing = false;
    Clear();
    Fade.Reset("");
    Identity = ReadIdentity();
    if (Streaming && !Motion.matches && !Document.hidden) {
      Fade.Reset(ReadText(Root).Text);
      Observing = true;
      Observer.observe(Root, { subtree: true, childList: true, characterData: true });
    }
  }

  function SetStreaming(Next: boolean) {
    if (Disposed || Next === Streaming) return;
    Streaming = Next;
    if (Next) {
      ResetObservation();
    } else {
      // The final text and completion flag can commit before the observer runs.
      Update();
      Observer.disconnect();
      Observing = false;
    }
  }

  Motion.addEventListener("change", ResetObservation);
  Document.addEventListener("visibilitychange", ResetObservation);
  function Dispose() {
    Disposed = true;
    Observing = false;
    Observer.disconnect();
    Motion.removeEventListener("change", ResetObservation);
    Document.removeEventListener("visibilitychange", ResetObservation);
    Clear();
  }
  return { SetStreaming, Dispose };
}
