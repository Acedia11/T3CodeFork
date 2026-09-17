import { describe, expect, it } from "vite-plus/test";
import { AceStreamingFade, AceStreamingOpacity } from "./AceStreamingFade";

describe("streamed text append fades", () => {
  it("leaves attached history settled and never replays a completed append", () => {
    const Fade = new AceStreamingFade("Already on screen.");
    expect(Fade.Advance("Already on screen.", 0)).toEqual([]);
    const [Chunk] = Fade.Advance("Already on screen. New", 10);
    expect(Chunk).toMatchObject({ Start: 18, End: 22, Arrived: 10 });
    expect(Fade.Advance("Already on screen. New", 500)).toEqual([]);
    expect(Fade.Advance("Already on screen. New", 1000)).toEqual([]);
  });

  it("fades incremental words within a paragraph without restarting earlier words", () => {
    const Fade = new AceStreamingFade("Read");
    const [First] = Fade.Advance("Read this", 0);
    const [Retained, Second] = Fade.Advance("Read this as it arrives", 150);
    expect(Retained).toBe(First);
    expect(Second).toMatchObject({ Start: 9, End: 23, Arrived: 150 });
    expect(AceStreamingOpacity(First!, 150)).toBeGreaterThan(0);
    expect(AceStreamingOpacity(Second!, 150)).toBe(0);
    expect(Fade.Advance("Read this as it arrives", 450)).toEqual([Second]);
  });

  it("settles Markdown rewrites instead of fading text that was already read", () => {
    const Fade = new AceStreamingFade("A **bold");
    Fade.Advance("A **bold word", 0);
    expect(Fade.Advance("A bold word", 50)).toEqual([]);
    expect(Fade.Advance("A bold word follows.", 80)).toEqual([
      expect.objectContaining({ Start: 11, End: 20, Arrived: 80 }),
    ]);
  });

  it("keeps arrival times when syntax highlighting replaces nodes with identical text", () => {
    const Fade = new AceStreamingFade("const");
    const [Chunk] = Fade.Advance("const Value = 1;", 20);
    expect(Fade.Advance("const Value = 1;", 100)).toEqual([Chunk]);
    expect(AceStreamingOpacity(Chunk!, 200)).toBeGreaterThan(AceStreamingOpacity(Chunk!, 100));
    expect(AceStreamingOpacity(Chunk!, 1000)).toBe(1);
  });

  it("adapts to fast arrivals while keeping the fade between 120 and 400 ms", () => {
    const Fade = new AceStreamingFade("");
    let Text = "";
    for (let Index = 0; Index < 30; Index++) {
      Text += "x";
      const Chunk = Fade.Advance(Text, Index * 10).at(-1)!;
      expect(Chunk.Duration).toBeGreaterThanOrEqual(120);
      expect(Chunk.Duration).toBeLessThanOrEqual(400);
    }
    expect(Fade.Advance(Text, 290).at(-1)?.Duration).toBe(120);
    expect(Fade.Advance(`${Text} after a pause`, 4000).at(-1)?.Duration).toBe(400);
  });

  it("recycles a message baseline without carrying over its active fades", () => {
    const Fade = new AceStreamingFade("First");
    Fade.Advance("First response", 0);
    Fade.Reset("First response from another message");
    expect(Fade.Advance("First response from another message", 10)).toEqual([]);
    expect(Fade.Advance("First response from another message.", 20)).toEqual([
      expect.objectContaining({ Start: 35, End: 36, Arrived: 20 }),
    ]);
  });

  it("keeps a surrogate pair in one non-overlapping character range", () => {
    const Fade = new AceStreamingFade("");
    Fade.Advance("Hi \ud83d", 0);
    const Chunks = Fade.Advance("Hi 😀", 20);
    expect(Chunks.map(({ Start, End }) => [Start, End])).toEqual([
      [0, 3],
      [3, 5],
    ]);
  });
});
