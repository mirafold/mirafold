const TRANSCRIPT_CONTROL_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "details",
  "summary",
  "iframe",
  "audio",
  "video",
  "[contenteditable]:not([contenteditable='false'])",
  "[draggable='true']",
  "[data-transcript-control]",
  "[tabindex]",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='option']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='tab']",
  "[role='treeitem']",
].join(",");

type TranscriptPointer = {
  pointerType: string;
  button: number;
  isPrimary: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
};

function pointsAtControl(target: EventTarget | null, transcript: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(TRANSCRIPT_CONTROL_SELECTOR);
  return control !== null && control !== transcript && transcript.contains(control);
}

/** Only an ordinary click on inert transcript content asks for prompt focus.
 * Controls, touch, secondary pointers, and live text selection retain control. */
export function shouldFocusPromptFromTranscriptPointer(
  event: TranscriptPointer,
  transcript: HTMLElement,
  hasLiveSelection: boolean,
): boolean {
  return (
    event.pointerType === "mouse" &&
    event.button === 0 &&
    event.isPrimary &&
    !event.defaultPrevented &&
    !pointsAtControl(event.target, transcript) &&
    !hasLiveSelection
  );
}
