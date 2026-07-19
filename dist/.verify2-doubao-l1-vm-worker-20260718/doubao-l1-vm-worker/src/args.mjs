export function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${item}`);
    }

    const equalIndex = item.indexOf("=");
    if (equalIndex !== -1) {
      options[item.slice(2, equalIndex)] = item.slice(equalIndex + 1);
      continue;
    }

    const name = item.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options[name] = next;
      index += 1;
    } else {
      options[name] = true;
    }
  }

  return { command, options };
}

export function integerOption(options, name, fallback, { min = 1, max = 65_535 } = {}) {
  const value = options[name] ?? fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}
