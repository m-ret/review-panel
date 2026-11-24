/**
 * Server-sent events, the format streamed replies arrive in.
 * The network cuts the stream wherever it likes, so a line is only read once
 * its line ending has arrived, and whatever is left is read at the end.
 */
export function createSseReader(onData: (data: string) => void): { push(chunk: string): void; end(): void } {
  let buffer = "";
  let data: string[] = [];

  function readLine(line: string): void {
    if (line === "") {
      if (data.length > 0) onData(data.join("\n"));
      data = [];
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    const value = colon < 0 ? "" : line.slice(colon + 1);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }

  return {
    push(chunk) {
      buffer += chunk;
      // A CR at the very end may be the first half of a CRLF, so it waits.
      const held = buffer.endsWith("\r") ? "\r" : "";
      const lines = buffer.slice(0, buffer.length - held.length).split(/\r\n|\r|\n/u);
      buffer = (lines.pop() ?? "") + held;
      for (const line of lines) readLine(line);
    },
    end() {
      for (const line of buffer.split(/\r\n|\r|\n/u)) readLine(line);
      readLine("");
      buffer = "";
    },
  };
}
