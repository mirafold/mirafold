import { useState } from "react";
import { notifyPrefEnabled, setNotifyPref } from "./notify";

/**
 * The needs-you notification preference plus the browser's own grant, both
 * shell-owned. Off by default; flipping it on is the ONLY thing that asks
 * the browser for notification permission (never page load). "unsupported"
 * (iOS Safari outside an installed PWA) hides the settings section.
 */
export function useNotifyPreference() {
  const [notifyOn, setNotifyOn] = useState(
    () => typeof Notification !== "undefined" && notifyPrefEnabled(),
  );
  const [notifyPerm, setNotifyPerm] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const toggleNotify = () => {
    if (notifyOn) {
      setNotifyPref(false);
      setNotifyOn(false);
      return;
    }
    if (notifyPerm === "default") {
      // Enable only once granted — an "on" toggle that can never fire is a lie.
      void Notification.requestPermission().then((p) => {
        setNotifyPerm(p);
        if (p === "granted") {
          setNotifyPref(true);
          setNotifyOn(true);
        }
      });
      return;
    }
    // "denied" still flips the preference on — the card's hint line says why
    // it stays silent, and un-blocking in the browser then just works.
    setNotifyPref(true);
    setNotifyOn(true);
  };
  return { notifyOn, notifyPerm, toggleNotify };
}
