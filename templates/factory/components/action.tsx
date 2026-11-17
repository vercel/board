"use client";

import type { ReactNode } from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Something the page does when asked: a POST to its own route, then a fresh check. */
export function Action({ label, path }: { label: string; path: string }): ReactNode {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const response = await fetch(path, { method: "POST" }).catch(() => null);
          setFailed(!response?.ok);
          router.refresh();
        })
      }
    >
      {pending ? "Starting" : failed ? "Try again" : label}
    </button>
  );
}
