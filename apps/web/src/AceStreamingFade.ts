export interface AceStreamingChunk {
  readonly Start: number;
  readonly End: number;
  readonly Arrived: number;
  readonly Duration: number;
}

export function AceStreamingOpacity(Chunk: AceStreamingChunk, Now: number) {
  const Progress = Math.min(1, Math.max(0, (Now - Chunk.Arrived) / Chunk.Duration));
  return 1 - (1 - Progress) ** 1.6;
}

export class AceStreamingFade {
  private Text: string;
  private Chunks: AceStreamingChunk[] = [];
  private Gap = 160;
  private LastAppend: number | null = null;

  constructor(Text: string) {
    this.Text = Text;
  }

  Reset(Text: string) {
    this.Text = Text;
    this.Chunks = [];
    this.Gap = 160;
    this.LastAppend = null;
  }

  Advance(Text: string, Now: number): readonly AceStreamingChunk[] {
    this.Chunks = this.Chunks.filter((Chunk) => Now - Chunk.Arrived < Chunk.Duration);
    if (Text === this.Text) return this.Chunks;
    if (!Text.startsWith(this.Text)) {
      // Closing Markdown delimiters can rewrite earlier text. Keep that text settled.
      this.Reset(Text);
      return this.Chunks;
    }

    let Start = this.Text.length;
    const Before = Text.charCodeAt(Start - 1);
    const After = Text.charCodeAt(Start);
    if (Before >= 0xd800 && Before <= 0xdbff && After >= 0xdc00 && After <= 0xdfff) {
      Start -= 1;
      this.Chunks = this.Chunks.filter((Chunk) => Chunk.Start < Start).map((Chunk) => ({
        ...Chunk,
        End: Math.min(Chunk.End, Start),
      }));
    }
    if (this.LastAppend !== null) {
      this.Gap = this.Gap * 0.7 + Math.min(1000, Math.max(0, Now - this.LastAppend)) * 0.3;
    }
    this.Chunks.push({
      Start,
      End: Text.length,
      Arrived: Now,
      Duration: Math.min(400, Math.max(120, this.Gap * 3)),
    });
    this.Text = Text;
    this.LastAppend = Now;
    return this.Chunks;
  }
}
