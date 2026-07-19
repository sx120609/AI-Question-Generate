import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { connectDoubao } from "../../../../doubao-automation/src/doubao-client.mjs";

const [stateArg] = process.argv.slice(2);
if (!stateArg) throw new Error("Usage: node repair_round6_artifact_evidence.mjs <result.json>");
const statePath = path.resolve(stateArg);
const state = JSON.parse(await readFile(statePath, "utf8"));
const round = state.rounds?.find((item) => Number(item.index) === 6);
if (!round?.response?.responseIdentity) throw new Error("Round 6 response is unavailable.");

const { browser, page } = await connectDoubao("http://127.0.0.1:9229");
let evidence;
try {
  const card = page.locator('[data-testid="sheet-product-card"]');
  if (await card.count() !== 1) throw new Error("A unique sheet product card is not visible.");
  const beforeUrl = page.url();
  const attributes = await card.evaluate((element) => ({
    cardStatus: element.getAttribute("data-card-status") || "",
    cardUnsupported: element.getAttribute("data-card-unsupported") || "",
    text: (element.innerText || element.textContent || "").trim(),
  }));
  if (attributes.cardStatus !== "2" || attributes.cardUnsupported !== "false") {
    throw new Error("The sheet product card is not in an accessible completed state.");
  }
  await card.click({ timeout: 15_000 });
  await page.waitForTimeout(1_000);
  const afterUrl = page.url();
  const parsed = new URL(afterUrl);
  const payload = JSON.parse(parsed.searchParams.get("canvas_impayload") || "{}");
  if (parsed.searchParams.get("pluginId") !== "ai-sheet-canvas"
    || !payload.artifactMetaId || !payload.docToken
    || String(payload.conversationId) !== String(round.response.conversationId)) {
    throw new Error("The sheet card did not open a conversation-bound sheet canvas.");
  }
  evidence = {
    accessState: "opened-in-doubao-sheet-canvas",
    artifactMetaId: String(payload.artifactMetaId),
    beforeUrl,
    cardStatus: attributes.cardStatus,
    cardUnsupported: attributes.cardUnsupported,
    docTitle: String(payload.docTitle || attributes.text),
    docToken: String(payload.docToken),
    href: afterUrl,
    pass: true,
    verifiedAt: new Date().toISOString(),
  };
} finally {
  await browser.close();
}

const artifact = round.response.artifacts?.find((item) =>
  item.dataTestId === "sheet-product-card" || /图形工作站到货预验收核对表/u.test(item.text || ""));
if (!artifact) throw new Error("The round 6 sheet artifact record is unavailable.");
Object.assign(artifact, evidence);
round.artifactAccessVerification = evidence;
round.feedbackRewrite = null;
round.feedbackPreflight = null;
round.feedbackPreflightFailure = {
  failedAt: new Date().toISOString(),
  message: "产物卡已通过实际点击打开豆包表格画布，artifactMetaId 与 docToken 均已读回。评价直接说明在线表格可访问并满足交付要求，省去原生文件与在线表格的否定式对立表达。",
  repairedArtifactEvidence: true,
};
round.status = "feedback_preflight";
delete state.error;
delete state.pause;

const temporaryPath = `${statePath}.repairing`;
await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
await rename(temporaryPath, statePath);
process.stdout.write(JSON.stringify(evidence));
