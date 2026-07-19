import test from "node:test";
import assert from "node:assert/strict";

import { integerOption, parseArgs } from "../src/args.mjs";

test("parses command options and flags", () => {
  assert.deepEqual(
    parseArgs(["fill", "--port", "9229", "--text=hello", "--clear-after"]),
    {
      command: "fill",
      options: { port: "9229", text: "hello", "clear-after": true },
    },
  );
});

test("rejects invalid port values", () => {
  assert.throws(() => integerOption({ port: "0" }, "port", 9229), /between 1 and 65535/u);
});
