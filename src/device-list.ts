/**
 * Reading azula's `list_devices` output.
 *
 * One parser for the format, shared by everything that reads it: the check that a
 * configured device is paired (`bridge.ts`) and the watch for a phone that has
 * just paired (`pairing.ts`). It lives in its own module because `pairing.ts`
 * imports the bridge, and the bridge needs this.
 */

/** Device name → status (`connected`, `disconnected`, `offline`). */
export type DeviceTable = ReadonlyMap<string, string>;

/**
 * Parse `list_devices` output.
 *
 * Rows look like `  <name>  [<fingerprint>…]  connected`; the heading
 * (`Known devices:`) and the empty case (`No devices registered…`) match no row.
 * A name may contain spaces (`azula pair --name "my phone"`), so the name is
 * everything before the bracketed fingerprint.
 */
export function parseDeviceLines(lines: readonly string[]): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of lines) {
    const match = line.trim().match(/^(.+?)\s+\[[^\]]*\]\s+(\w+)$/);
    if (match?.[1] && match[2]) table.set(match[1], match[2]);
  }
  return table;
}
