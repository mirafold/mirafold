import { useEffect, useRef, useState } from "react";

/**
 * Stdin for the running `!` command — SHELL-OWNED UI on the ephemeral
 * input path: what's typed here goes to the PTY and nowhere else (never the
 * replay ring, never other viewports), and only the issuing viewport mounts
 * it. Masks itself when the command's output ends in a password prompt
 * (echo-off input never comes back as output, so masking here is the only
 * echo there is); a toggle overrides the guess either way.
 */
export function BangBar({
  command,
  tail,
  onInput,
  onKill,
}: {
  command: string;
  tail: string;
  onInput: (data: string) => void;
  onKill: () => void;
}) {
  const [val, setVal] = useState("");
  const [maskOverride, setMaskOverride] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  const maskAuto = /pass(word|phrase)/i.test(lastLine) && /:\s*$/.test(lastLine);
  const masked = maskOverride ?? maskAuto;

  // A password prompt appearing is the moment the user wants to type here.
  useEffect(() => {
    if (maskAuto) inputRef.current?.focus();
  }, [maskAuto]);

  return (
    <div className="bang-bar">
      <span className="bang-bar-badge">!</span>
      <span className="bang-bar-cmd" title={command}>
        {command}
      </span>
      <input
        ref={inputRef}
        className="bang-bar-input"
        type={masked ? "password" : "text"}
        value={val}
        spellCheck={false}
        autoComplete="off"
        placeholder={masked ? "password — sent to the command only, never stored" : "stdin"}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onInput(val + "\n");
            setVal("");
            setMaskOverride(null); // re-detect on the next prompt
          } else if (e.key === "c" && e.ctrlKey) {
            e.preventDefault();
            onInput("\x03"); // SIGINT to the foreground process, like a terminal
          } else if (e.key === "Escape") {
            onKill();
          }
        }}
      />
      <button
        className="bang-bar-mask"
        onClick={() => setMaskOverride(!masked)}
        title={masked ? "Show what I type" : "Mask what I type"}
      >
        {masked ? "abc" : "•••"}
      </button>
      <button className="bang-bar-kill" onClick={onKill} title="Kill the command (Esc)">
        ■ kill
      </button>
    </div>
  );
}
