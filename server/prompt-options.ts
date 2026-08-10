import type { PromptOption } from "./protocol";

const PROMPT_OPTION_CAP = 500;
const PROMPT_VALUE_CAP = 200;
const PROMPT_LABEL_CAP = 120;
const PROMPT_DESCRIPTION_CAP = 500;
const PROMPT_ALIAS_CAP = 20;

// Provider catalogs can include repository/plugin metadata. React already
// renders it as inert text, but invisible direction/line controls can still
// make that text visually impersonate different shell copy. Drop the whole
// entry instead of rewriting its command into something the provider did not
// advertise.
const UNSAFE_DISPLAY_CONTROL =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;

export function promptOptionIsControlSafe(option: PromptOption): boolean {
  return [
    option.value,
    option.label,
    option.description,
    option.argumentHint,
    ...(option.aliases ?? []),
  ].every((value) => value === undefined || !UNSAFE_DISPLAY_CONTROL.test(value));
}

const capText = (value: string, cap: number) =>
  value.length > cap ? value.slice(0, cap) + "…" : value;

/** The one catalog normalization policy before trusted-shell rendering and
 * checkpointing. Command values are never truncated: an oversized or
 * deceptive entry is dropped rather than changed into another command. */
export function normalizePromptOptions(options: PromptOption[]): PromptOption[] {
  return options.slice(0, PROMPT_OPTION_CAP).flatMap((option) => {
    if (
      option.value.length > PROMPT_VALUE_CAP ||
      !option.value.startsWith(option.trigger) ||
      !promptOptionIsControlSafe(option)
    ) {
      return [];
    }
    return [
      {
        ...option,
        label: capText(option.label, PROMPT_LABEL_CAP),
        ...(option.description !== undefined
          ? { description: capText(option.description, PROMPT_DESCRIPTION_CAP) }
          : {}),
        ...(option.argumentHint !== undefined
          ? { argumentHint: capText(option.argumentHint, PROMPT_VALUE_CAP) }
          : {}),
        ...(option.aliases !== undefined
          ? {
              aliases: option.aliases
                .slice(0, PROMPT_ALIAS_CAP)
                .filter((alias) => alias.length <= PROMPT_VALUE_CAP),
            }
          : {}),
      },
    ];
  });
}
