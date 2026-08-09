import type { ChildProcess } from "node:child_process";

export type BrowserOpenCommand = { file: string; args: string[] };

export function browserOpenCommand(
  url: string,
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
  canRun?: (file: string) => boolean,
): BrowserOpenCommand | undefined;

export function browserOpenEnvironment(
  source?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): Record<string, string>;

export function openBrowser(
  url: string,
  opts?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    command?: BrowserOpenCommand;
  },
): ChildProcess | undefined;
