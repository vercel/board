"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/** How often the page checks while it's in view and something is left to do. A check takes about a second. */
const EVERY = 5_000;

/**
 * Keeps the page's checks current, with nothing to press: again whenever the tab or the window comes
 * back, and every few seconds while the page is in view and `polling`. Never two at once, and never
 * while the page is hidden.
 */
export function Live({ polling }: { polling: boolean }): null {
  const router = useRouter();
  const [pending, start] = useTransition();
  const busy = useRef(false);
  useEffect(() => {
    busy.current = pending;
  }, [pending]);
  useEffect(() => {
    let last = 0;
    const check = () => {
      // Coming back fires both events at once: one check, not two.
      if (document.visibilityState !== "visible" || busy.current || Date.now() - last < 1_000) return;
      last = Date.now();
      start(() => router.refresh());
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const timer = polling ? setInterval(check, EVERY) : undefined;
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, [polling, router]);
  return null;
}
