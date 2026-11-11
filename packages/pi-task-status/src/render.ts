export function formatTaskStatusResult(
  text: string,
  expanded: boolean,
  isError: boolean,
  expandHint: string,
): string[] {
  const lines = text.split("\n");
  if (expanded || isError || lines.length <= 1) return lines;
  return [`${lines[0]}  ${expandHint}`];
}
