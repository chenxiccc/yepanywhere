/**
 * Switch Host cache-busts the current document so an installed window can
 * refresh its bundle without navigating to /login. Chrome shortcuts created
 * on a session URL treat /login as out of scope; reloading the current href
 * stays inside that window. The mark tells the next boot to skip reconnect
 * and open the host picker.
 */

export const SWITCH_HOST_RELOAD_STORAGE_KEY = "yep-anywhere-switch-host-reload";

let consumedThisDocument: boolean | null = null;

export function markSwitchHostReload(): void {
  consumedThisDocument = null;
  sessionStorage.setItem(SWITCH_HOST_RELOAD_STORAGE_KEY, "1");
}

export function consumeSwitchHostReload(): boolean {
  if (consumedThisDocument !== null) {
    return consumedThisDocument;
  }
  try {
    consumedThisDocument =
      sessionStorage.getItem(SWITCH_HOST_RELOAD_STORAGE_KEY) === "1";
    if (consumedThisDocument) {
      sessionStorage.removeItem(SWITCH_HOST_RELOAD_STORAGE_KEY);
    }
  } catch {
    consumedThisDocument = false;
  }
  return consumedThisDocument;
}

export function resetSwitchHostReloadConsumptionForTests(): void {
  consumedThisDocument = null;
}
