import { invoke, isTauri } from "@tauri-apps/api/core";
export const desktop = isTauri();
export async function rpc<T = import("./types").Snapshot>(
  op: Record<string, unknown>,
): Promise<T> {
  if (!desktop)
    throw new Error(
      "Open Vessel on your desktop to connect to the terminal daemon. Run npm run desktop from the project directory.",
    );
  return invoke<T>("rpc", { op });
}
export async function listShells(
  configured: string,
): Promise<import("./types").ShellOption[]> {
  if (!desktop) return [{ label: "System default", path: "" }];
  return invoke("available_shells", { configured });
}
export async function readTerminal(
  id: string,
  cursor: number | null,
  readerId: string,
): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_terminal", {
    id,
    cursor,
    readerId,
  });
  return new Uint8Array(buffer);
}
