import { describe, expect, test } from "bun:test";
import { createSseReader } from "../src/sse.ts";

function read(...chunks: string[]): string[] {
  const seen: string[] = [];
  const reader = createSseReader((data) => seen.push(data));
  for (const chunk of chunks) reader.push(chunk);
  reader.end();
  return seen;
}

describe("createSseReader", () => {
  test("gives each event's data in order", () => {
    expect(read("data: one\n\ndata: two\n\n")).toEqual(["one", "two"]);
  });

  test("joins a frame that the network split in the middle of a word", () => {
    expect(read('data: {"a":', '"b"}\n', "\ndata: [DO", "NE]\n\n")).toEqual(['{"a":"b"}', "[DONE]"]);
  });

  test("reads the last event even when the stream ends without a blank line", () => {
    expect(read("data: one\n\ndata: last")).toEqual(["one", "last"]);
  });

  test("accepts CRLF line endings, also when CR and LF arrive in different chunks", () => {
    expect(read("data: one\r", "\n\r", "\ndata: two\r\n\r\n")).toEqual(["one", "two"]);
  });

  test("a CRLF split between two chunks is one line ending, not an empty line that would end the event", () => {
    expect(read("data: one\r", "\ndata: two\r\n\r\n")).toEqual(["one\ntwo"]);
  });

  test("ignores keep-alive comments and other fields", () => {
    expect(read(": keep-alive\n\nevent: ping\nid: 7\nretry: 100\n\ndata: one\n\n")).toEqual(["one"]);
  });

  test("joins several data lines of one event, as the SSE rules say", () => {
    expect(read("data: one\ndata: two\n\n")).toEqual(["one\ntwo"]);
  });

  test("removes only the one space after the colon", () => {
    expect(read("data:  indented\n\ndata:tight fit\n\n")).toEqual([" indented", "tight fit"]);
  });

  test("an empty data line is still an event with empty data", () => {
    expect(read("data:\n\n")).toEqual([""]);
  });
});
