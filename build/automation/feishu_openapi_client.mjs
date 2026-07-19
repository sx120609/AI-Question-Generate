import fs from "node:fs/promises";
import path from "node:path";
import { requestLarkCliApi } from "./feishu_lark_cli_client.mjs";
import {
  assertClearQuestionRequest,
  assertNaturalQuestionPresentation,
  assertSingleParagraphQuestion,
} from "./language_style.mjs";
import { verifyReleaseReceiptUpdates } from "./release_gate.mjs";

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const RELEASE_BOUND_NARRATIVE_FIELDS = new Map([
  ["B", "题目"],
  ["G", "任务概括"],
  ["L", "附件内容"],
  ["N", "产物内容"],
  ["O", "做题关键步骤"],
]);

function env(name) {
  return process.env[name]?.trim() || "";
}

function ensureOpenApiPath(apiPath) {
  if (!apiPath.startsWith("/")) return `/open-apis/${apiPath}`;
  if (apiPath.startsWith("/open-apis/")) return apiPath;
  return `/open-apis${apiPath}`;
}

function headersFromResponse(response) {
  return {
    requestId: response.headers.get("x-request-id") || response.headers.get("x-tt-logid") || "",
    status: response.status,
  };
}

export function parseFeishuUrl(input) {
  const text = String(input ?? "").trim();
  if (!text) return {};

  let url;
  try {
    url = new URL(text);
  } catch {
    return { raw: text };
  }

  const sheetMatch = url.pathname.match(/\/sheets\/([^/?#]+)/);
  const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
  return {
    raw: text,
    host: url.host,
    spreadsheetToken: sheetMatch?.[1] || "",
    wikiToken: wikiMatch?.[1] || "",
    sheetId: url.searchParams.get("sheet") || "",
  };
}

export function rangeForCell(sheetId, address) {
  if (!sheetId) throw new Error("rangeForCell requires sheetId.");
  if (!/^[A-Z]+[1-9]\d*$/.test(address)) throw new Error(`Invalid A1 address: ${address}`);
  return `${sheetId}!${address}:${address}`;
}

function columnNumber(label) {
  return String(label ?? "").toUpperCase().split("").reduce(
    (value, character) => (value * 26) + character.charCodeAt(0) - 64,
    0,
  );
}

function columnLabel(number) {
  let value = Number(number);
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function parseA1Span(range) {
  const address = String(range ?? "").split("!").at(-1)?.trim() ?? "";
  const match = address.match(/^\$?([A-Z]+)(?:\$?([1-9]\d*))?(?::\$?([A-Z]+)(?:\$?([1-9]\d*))?)?$/iu);
  if (!match) return null;
  return {
    startColumn: columnNumber(match[1]),
    endColumn: columnNumber(match[3] || match[1]),
    startRow: match[2] ? Number(match[2]) : null,
    endRow: match[4] ? Number(match[4]) : match[2] ? Number(match[2]) : null,
  };
}

export function releaseBoundUpdatesFromValueRanges(valueRanges = []) {
  const updates = [];
  for (const valueRange of valueRanges) {
    const span = parseA1Span(valueRange?.range ?? valueRange?.address);
    if (!span) continue;
    const narrativeColumns = [...RELEASE_BOUND_NARRATIVE_FIELDS.entries()]
      .map(([column, field]) => ({ column, field, number: columnNumber(column) }))
      .filter(({ number }) => number >= span.startColumn && number <= span.endColumn);
    if (!narrativeColumns.length) continue;
    if (!span.startRow) {
      throw new Error(`Narrative OpenAPI write must use row-qualified A1 ranges: ${valueRange?.range ?? valueRange?.address ?? ""}`);
    }
    const rows = Array.isArray(valueRange?.values) ? valueRange.values : [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const sheetRow = span.startRow + rowIndex;
      if (span.endRow && sheetRow > span.endRow) {
        throw new Error(`Narrative OpenAPI values exceed declared range: ${valueRange?.range ?? valueRange?.address ?? ""}`);
      }
      const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [rows[rowIndex]];
      for (const { column, field, number } of narrativeColumns) {
        const offset = number - span.startColumn;
        if (offset >= row.length || row[offset] === undefined) continue;
        updates.push({
          address: `${columnLabel(number)}${sheetRow}`,
          column,
          field,
          value: row[offset],
        });
      }
    }
  }
  return updates;
}

export async function verifyReleaseReceiptForValueRanges({
  valueRanges = [],
  releaseReceiptPath = "",
  policyPath,
} = {}) {
  const updates = releaseBoundUpdatesFromValueRanges(valueRanges);
  if (!updates.length) return { required: false, verified: false, updates: [] };
  if (!releaseReceiptPath) {
    throw new Error("A v2 release-gate receipt is required at the physical OpenAPI boundary for B/G/L/N/O writes.");
  }
  const verification = await verifyReleaseReceiptUpdates({
    receiptPath: releaseReceiptPath,
    updates,
    policyPath,
  });
  if (!verification.ok) {
    throw new Error(`Physical OpenAPI release verification failed: ${verification.errors.join("; ")}`);
  }
  return {
    required: true,
    verified: true,
    releaseGateId: verification.receipt.releaseGateId,
    roleConsistencyStatus: verification.receipt.roleConsistency?.status,
    updates: verification.matchedUpdates,
  };
}

export function assertSingleParagraphQuestionValueRanges(valueRanges = []) {
  const questionColumn = columnNumber("B");
  for (const valueRange of valueRanges) {
    const span = parseA1Span(valueRange?.range);
    if (!span || questionColumn < span.startColumn || questionColumn > span.endColumn) continue;
    const valueOffset = questionColumn - span.startColumn;
    const rows = Array.isArray(valueRange?.values) ? valueRange.values : [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [rows[rowIndex]];
      if (valueOffset >= row.length) continue;
      const cell = `B${span.startRow ? span.startRow + rowIndex : "?"}`;
      assertSingleParagraphQuestion(row[valueOffset], { label: cell });
      assertClearQuestionRequest(row[valueOffset], { label: cell });
    }
  }
}

export function assertNaturalQuestionValueRanges(valueRanges = []) {
  const questionColumn = columnNumber("B");
  for (const valueRange of valueRanges) {
    const span = parseA1Span(valueRange?.range);
    if (!span || questionColumn < span.startColumn || questionColumn > span.endColumn) continue;
    const valueOffset = questionColumn - span.startColumn;
    const rows = Array.isArray(valueRange?.values) ? valueRange.values : [];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [rows[rowIndex]];
      if (valueOffset >= row.length) continue;
      const cell = `B${span.startRow ? span.startRow + rowIndex : "?"}`;
      assertNaturalQuestionPresentation(row[valueOffset], { label: cell });
      assertClearQuestionRequest(row[valueOffset], { label: cell });
    }
  }
}

export async function createFeishuClient(options = {}) {
  const baseUrl = options.baseUrl || env("FEISHU_OPENAPI_BASE_URL") || DEFAULT_BASE_URL;
  const transport = options.transport || env("FEISHU_OPENAPI_TRANSPORT") || env("FEISHU_TRANSPORT") || "auto";
  const explicitToken =
    options.accessToken ||
    env("FEISHU_USER_ACCESS_TOKEN") ||
    env("FEISHU_TENANT_ACCESS_TOKEN") ||
    env("FEISHU_ACCESS_TOKEN");
  const appId = options.appId || env("FEISHU_APP_ID");
  const appSecret = options.appSecret || env("FEISHU_APP_SECRET");
  const shouldUseLarkCli =
    transport === "lark-cli" || (transport === "auto" && !explicitToken && !(appId && appSecret));

  let cachedToken = explicitToken;

  async function fetchTenantAccessToken() {
    if (!appId || !appSecret) {
      throw new Error(
        "Missing Feishu auth. Set FEISHU_USER_ACCESS_TOKEN / FEISHU_TENANT_ACCESS_TOKEN, FEISHU_APP_ID + FEISHU_APP_SECRET, or configure lark-cli user login."
      );
    }

    const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const json = await response.json();
    if (!response.ok || json.code !== 0) {
      const meta = headersFromResponse(response);
      throw new Error(`Feishu token request failed: ${json.msg || response.statusText} (${meta.requestId})`);
    }
    return json.tenant_access_token;
  }

  async function getToken() {
    if (!cachedToken) cachedToken = await fetchTenantAccessToken();
    return cachedToken;
  }

  async function requestJson(method, apiPath, { params = {}, data, headers = {} } = {}) {
    if (shouldUseLarkCli) {
      const json = await requestLarkCliApi({
        method,
        apiPath: ensureOpenApiPath(apiPath),
        params,
        data,
        as: options.larkCliIdentity || env("FEISHU_LARK_CLI_AS") || "user",
      });
      if (json.code !== undefined && json.code !== 0) {
        throw new Error(`Feishu API ${method} ${apiPath} failed via lark-cli: ${json.msg || "unknown error"}; code=${json.code}`);
      }
      return json;
    }

    const url = new URL(`${baseUrl}${ensureOpenApiPath(apiPath)}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    const token = await getToken();
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!response.ok || (json.code !== undefined && json.code !== 0)) {
      const meta = headersFromResponse(response);
      throw new Error(
        `Feishu API ${method} ${apiPath} failed: ${json.msg || response.statusText}; code=${json.code ?? response.status}; requestId=${meta.requestId}`
      );
    }
    return json;
  }

  return {
    baseUrl,
    requestJson,
    async getWikiNode(wikiToken) {
      const json = await requestJson("GET", "/wiki/v2/spaces/get_node", {
        params: { token: wikiToken },
      });
      return json.data?.node;
    },
    async getSpreadsheetMeta(spreadsheetToken) {
      const json = await requestJson("GET", `/sheets/v2/spreadsheets/${spreadsheetToken}/metainfo`);
      return json.data;
    },
    async resolveSpreadsheetTarget({ url = "", spreadsheetToken = "", sheetId = "", sheetTitle = "" } = {}) {
      const parsed = parseFeishuUrl(url);
      let token = spreadsheetToken || parsed.spreadsheetToken;
      let resolvedSheetId = sheetId || parsed.sheetId;
      let wikiNode = null;

      if (!token && parsed.wikiToken) {
        wikiNode = await this.getWikiNode(parsed.wikiToken);
        if (wikiNode?.obj_type !== "sheet") {
          throw new Error(`Wiki node is ${wikiNode?.obj_type || "unknown"}, not a sheet.`);
        }
        token = wikiNode.obj_token;
      }
      if (!token) throw new Error("Missing spreadsheet token. Provide --spreadsheet-token or --wiki-url.");

      let meta = null;
      if (!resolvedSheetId || sheetTitle) {
        meta = await this.getSpreadsheetMeta(token);
        const sheets = meta?.sheets || [];
        const selected = sheetTitle ? sheets.find((item) => item.title === sheetTitle) : sheets[0];
        if (!selected) {
          throw new Error(sheetTitle ? `Sheet title not found: ${sheetTitle}` : "Spreadsheet has no sheets.");
        }
        resolvedSheetId = selected.sheetId;
      }

      return {
        spreadsheetToken: token,
        sheetId: resolvedSheetId,
        wikiNode,
        meta,
      };
    },
    async batchUpdateValues({ spreadsheetToken, valueRanges, releaseReceiptPath = "", releasePolicyPath } = {}) {
      assertNaturalQuestionValueRanges(valueRanges);
      await verifyReleaseReceiptForValueRanges({
        valueRanges,
        releaseReceiptPath,
        policyPath: releasePolicyPath,
      });
      return requestJson("POST", `/sheets/v2/spreadsheets/${spreadsheetToken}/values_batch_update`, {
        data: { valueRanges },
      });
    },
    async readRange({ spreadsheetToken, range }) {
      const encodedRange = encodeURIComponent(range);
      const json = await requestJson("GET", `/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodedRange}`);
      return json.data?.valueRange;
    },
    async getDataValidations({ spreadsheetToken, range = "" }) {
      const json = await requestJson("GET", `/sheets/v2/spreadsheets/${spreadsheetToken}/dataValidation`, {
        params: { range },
      });
      return {
        dataValidations: json.data?.dataValidations || [],
        revision: json.data?.revision,
        sheetId: json.data?.sheetId || "",
      };
    },
  };
}

export async function findFilesByName(rootDir) {
  const out = new Map();

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const current = out.get(entry.name) || [];
        current.push(fullPath);
        out.set(entry.name, current);
      }
    }
  }

  await walk(rootDir);
  return out;
}
