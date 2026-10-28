export function parseSessionStatus(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  let contextLine = null;
  let modelLine = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!contextLine && line.includes("◫")) contextLine = line;
    if (!modelLine && line.includes("◉")) modelLine = line;
    if (contextLine && modelLine) break;
  }
  return {
    model: parseModel(modelLine ?? contextLine ?? ""),
    context: parseContext(contextLine ?? modelLine ?? ""),
  };
}

function parseModel(line) {
  const marker = line.indexOf("◉");
  if (marker < 0) return null;
  const value = line.slice(marker + 1).split("·")[0].trim();
  return value || null;
}

function parseContext(line) {
  const match = line.match(/◫\s*([0-9]+(?:\.[0-9]+)?)%\s*\/\s*([0-9]+(?:\.[0-9]+)?\s*[KMG]?)/i);
  if (!match) return null;
  return {
    percent: Number(match[1]),
    percentText: match[1],
    window: match[2].replace(/\s+/g, ""),
  };
}
