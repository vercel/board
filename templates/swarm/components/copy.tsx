"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Check, Copy as CopyIcon } from "lucide-react";

/**
 * Copies `text`, and says so for a moment: an icon beside a command, or with a `label`, a button of
 * its own. `quiet` makes that button a few words in a sentence, for something a person may want
 * and nobody needs.
 */
export function Copy({ text, label, quiet }: { text: string; label?: string; quiet?: boolean }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={quiet ? "link" : label ? "button secondary" : "copy"}
      aria-label={label ? undefined : copied ? "Copied" : "Copy"}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {quiet ? null : copied ? <Check size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
      {label ? (copied ? "Copied" : label) : null}
    </button>
  );
}
