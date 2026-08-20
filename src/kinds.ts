/** Job kinds registered by this plugin. Import this module for declaration merging. */

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "okf-ingest": "okf-ingest";
    "okf-compile": "okf-compile";
    "okf-survey": "okf-survey";
  }
}

export {};
