const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function cdpEndpoint({ host = "127.0.0.1", port }) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("The CDP endpoint must remain on a loopback address.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CDP port must be an integer between 1 and 65535.");
  }
  const urlHost = host === "::1" ? "[::1]" : host;
  return `http://${urlHost}:${port}`;
}

export async function fetchJson(url, { timeoutMs = 3_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForCdp(endpoint, {
  timeoutMs = 20_000,
  pollMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await fetchJson(`${endpoint}/json/version`, {
        timeoutMs: Math.min(2_000, Math.max(250, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  throw new Error(`Timed out waiting for CDP at ${endpoint}.`, {
    cause: lastError,
  });
}

export async function listTargets(endpoint) {
  const targets = await fetchJson(`${endpoint}/json/list`);
  if (!Array.isArray(targets)) {
    throw new Error("CDP target list was not an array.");
  }
  return targets;
}

export function selectDoubaoChatTarget(targets) {
  const pageTargets = targets.filter((target) => target?.type === "page");
  const exact = pageTargets.filter((target) =>
    ["doubao://doubao-chat/chat", "chrome://doubao-chat/chat"].includes(target.url),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Multiple exact Doubao chat targets were found: ${exact.length}`);
  }

  const candidates = pageTargets.filter((target) =>
    /^(?:doubao|chrome):\/\/doubao-chat\/chat(?:[/?#]|$)/iu.test(String(target.url ?? "")),
  );
  if (candidates.length !== 1) {
    throw new Error(`Expected one Doubao chat target, found ${candidates.length}.`);
  }
  return candidates[0];
}
