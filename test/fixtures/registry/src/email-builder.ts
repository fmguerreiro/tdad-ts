export function buildEmail(name: string, props: Record<string, unknown>): string {
  return `<email>${name}:${JSON.stringify(props)}</email>`;
}
