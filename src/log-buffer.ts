/** Incremental UTF-8 log for `job_output` (one consuming cursor). */

export class LineLog {
  private readonly lines: string[] = [];
  private cursor = 0;

  append(line: string): void {
    this.lines.push(line.replace(/\s+$/u, ""));
  }

  readOutput(): string {
    if (this.cursor >= this.lines.length) {
      return "";
    }
    const chunk = this.lines.slice(this.cursor).join("\n");
    this.cursor = this.lines.length;
    return `${chunk}\n`;
  }

  snapshot(): string {
    return this.lines.join("\n");
  }
}
