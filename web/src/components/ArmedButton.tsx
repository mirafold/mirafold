/** A two-click destructive control: the first click arms (the verb
 *  gains a "?"), a second click within the arm window fires. Shared by the
 *  fleet rows' stop (interrupt) and end buttons and the status bar's end —
 *  same idiom, different consequence. The aria labels are optional: the
 *  status bar's end button renders without one (its DOM must stay
 *  byte-identical). */
export function ArmedButton({
  className,
  verb,
  armed,
  title,
  armedTitle,
  ariaLabel,
  armedAriaLabel,
  onArm,
  onFire,
}: {
  className: string;
  verb: string;
  armed: boolean;
  title: string;
  armedTitle: string;
  ariaLabel?: string;
  armedAriaLabel?: string;
  onArm: () => void;
  onFire: () => void;
}) {
  return (
    <button
      className={className + (armed ? ` ${className}-armed` : "")}
      title={armed ? armedTitle : title}
      aria-label={armed ? armedAriaLabel : ariaLabel}
      onClick={armed ? onFire : onArm}
    >
      {armed ? `${verb}?` : verb}
    </button>
  );
}
