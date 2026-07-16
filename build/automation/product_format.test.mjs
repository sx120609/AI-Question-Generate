import assert from "node:assert/strict";
import test from "node:test";
import {
  activeGeneratedAnnotators,
  loadGeneratedIdentities,
  matchGeneratedIdentity,
} from "./generated_identities.mjs";
import { analyzeProductFormat, canonicalizeProductFormat } from "./product_format.mjs";

test("canonical product formats use extension-only labels", () => {
  assert.equal(canonicalizeProductFormat("docx, xlsx"), "docx, xlsx");
  assert.equal(analyzeProductFormat("docx, xlsx").isCanonical, true);
});

test("legacy verbose labels normalize at the submission boundary", () => {
  assert.equal(
    canonicalizeProductFormat("Word文档（docx）, Excel表格（xlsx）"),
    "docx, xlsx",
  );
  assert.equal(canonicalizeProductFormat("Word, Excel"), "docx, xlsx");
  assert.equal(canonicalizeProductFormat("PPT演示文稿（pptx）"), "pptx");
});

test("unknown product formats fail closed", () => {
  assert.throws(() => canonicalizeProductFormat("一份报告"), /Invalid product format/);
});

test("managed generated identities persist across sessions", async () => {
  const config = await loadGeneratedIdentities();
  assert.deepEqual(activeGeneratedAnnotators(config).map((item) => item.name), ["沈礼", "裴硬"]);
  assert.equal(matchGeneratedIdentity({ uid: "沈礼_7.10_01" }, config)?.name, "沈礼");
  assert.equal(matchGeneratedIdentity({ name: "裴硬" }, config)?.uidPrefix, "裴硬_");
});
