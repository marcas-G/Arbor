export function lineCount(text) {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/u);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

export function isSource(path) {
  return (
    /\.(?:[cm]?ts|tsx|[cm]?js|jsx|py|sh|bash|ps1|sql|css|scss|less|html|rs|go|c|cc|cpp|h|hpp|java|kt|cs|rb|lua|vue|svelte)$/iu.test(
      path,
    ) && !/(?:^|\/)(?:node_modules|dist|coverage|\.git)(?:\/|$)/u.test(path)
  );
}

export function inspectFile(path, content, baselineCount) {
  const lines = lineCount(content);
  if (lines <= 800) return null;
  const legacy =
    baselineCount !== undefined &&
    baselineCount > 800 &&
    lines <= baselineCount;
  return {
    path,
    lines,
    excess: lines - 800,
    baselineCount: baselineCount ?? null,
    legacy,
  };
}
