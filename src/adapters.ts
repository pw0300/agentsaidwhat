/** Live provider behavior has not been validated for these text connectors. */
export function adapterLabel(name: string = ''): string {
  return /^(vapi|retell|pipecat|livekit):\/\//i.test(name) ? `${name} (experimental)` : name
}
