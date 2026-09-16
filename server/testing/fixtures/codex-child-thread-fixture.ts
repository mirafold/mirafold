// The Codex app-server 0.153.4 notification sequence captured LIVE on
// 2026-09-15 (Kyle-authorized TF5.2 run, ChatGPT login, gpt-6-astra) for
// one prompt that spawns a subagent, waits for it, and runs a command.
// Thread ids are replaced by ROOT/CHILD; the prose deltas and token/rate
// bookkeeping are omitted; command output is the observed text. What it
// proves: a spawn surfaces as `subAgentActivity started` (no collab spawn
// item), the child's own items arrive on the PARENT connection under the
// child's thread id, and the parent's `wait` collab call carries no
// receivers or states. A fixture proves the adapter's handling of this
// shape; the live capture proves this version emitted it.
export const CODEX_CHILD_THREAD_SEQUENCE: Array<[method: string, params: Record<string, unknown>]> = [
  [
    "turn/started",
    {
      "threadId": "ROOT",
      "turn": {
        "id": "t1",
        "status": "completed"
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_043ea5034e45b312016aa962f31a8887d0a268a548f0b931c8",
        "text": "",
        "phase": "commentary"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_043ea5034e45b312016aa962f31a8887d0a268a548f0b931c8",
        "text": "I\u2019ll start one subagent, wait for its answer, then run `echo done`.\n",
        "phase": "commentary"
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "subAgentActivity",
        "id": "call_rnx6EcoxdpdZkJDRyC7cKdp0",
        "kind": "started",
        "agentThreadId": "CHILD",
        "agentPath": "/root/list_files"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "subAgentActivity",
        "id": "call_rnx6EcoxdpdZkJDRyC7cKdp0",
        "kind": "started",
        "agentThreadId": "CHILD",
        "agentPath": "/root/list_files"
      }
    }
  ],
  [
    "turn/started",
    {
      "threadId": "CHILD",
      "turn": {
        "id": "t1",
        "status": "completed"
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "collabAgentToolCall",
        "id": "call_aTqhJJ7YLRWFZwj7KUDCb3sT",
        "tool": "wait",
        "status": "inProgress",
        "senderThreadId": "ROOT",
        "receiverThreadIds": [],
        "prompt": null,
        "agentsStates": {}
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "reasoning",
        "id": "rs_0d4facf94357bb72016aa962fa358887d09a7c0f499045737b",
        "summary": []
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "reasoning",
        "id": "rs_0d4facf94357bb72016aa962fa358887d09a7c0f499045737b",
        "summary": []
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_0d4facf94357bb72016aa962fd605487d0bfd9204321104928",
        "text": "",
        "phase": "commentary"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_0d4facf94357bb72016aa962fd605487d0bfd9204321104928",
        "text": "I\u2019ll list the files in this directory.\n",
        "phase": "commentary"
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "commandExecution",
        "id": "exec-61a71770-b7d9-4c92-9ca6-23a2c5543706",
        "command": "/usr/bin/zsh -lc ls",
        "status": "inProgress",
        "commandActions": [
          {
            "type": "listFiles",
            "command": "ls",
            "path": null
          }
        ],
        "aggregatedOutput": "alpha.txt\nbeta.md\n",
        "exitCode": null,
        "durationMs": null
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "commandExecution",
        "id": "exec-61a71770-b7d9-4c92-9ca6-23a2c5543706",
        "command": "/usr/bin/zsh -lc ls",
        "status": "completed",
        "commandActions": [
          {
            "type": "listFiles",
            "command": "ls",
            "path": null
          }
        ],
        "aggregatedOutput": "alpha.txt\nbeta.md\n",
        "exitCode": 0,
        "durationMs": 0
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_0d4facf94357bb72016aa963006ed087d08798e48978217537",
        "text": "",
        "phase": "final_answer"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "CHILD",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_0d4facf94357bb72016aa963006ed087d08798e48978217537",
        "text": "The files are alpha.txt and beta.md.",
        "phase": "final_answer"
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "subAgentActivity",
        "id": "subagent-completed-01a0a5aa-8dbd-7483-9a3a-1c2ac45b3cd8",
        "kind": "completed",
        "agentThreadId": "CHILD",
        "agentPath": "/root/list_files"
      }
    }
  ],
  [
    "turn/completed",
    {
      "threadId": "CHILD",
      "turn": {
        "id": "t1",
        "status": "completed"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "subAgentActivity",
        "id": "subagent-completed-01a0a5aa-8dbd-7483-9a3a-1c2ac45b3cd8",
        "kind": "completed",
        "agentThreadId": "CHILD",
        "agentPath": "/root/list_files"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "collabAgentToolCall",
        "id": "call_aTqhJJ7YLRWFZwj7KUDCb3sT",
        "tool": "wait",
        "status": "completed",
        "senderThreadId": "ROOT",
        "receiverThreadIds": [],
        "prompt": null,
        "agentsStates": {}
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "reasoning",
        "id": "rs_043ea5034e45b312016aa9630236c887d08f53fbbdf1bb5180",
        "summary": []
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "reasoning",
        "id": "rs_043ea5034e45b312016aa9630236c887d08f53fbbdf1bb5180",
        "summary": []
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_043ea5034e45b312016aa96305e7cc87d0a5dbeac8bd8a909b",
        "text": "",
        "phase": "commentary"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_043ea5034e45b312016aa96305e7cc87d0a5dbeac8bd8a909b",
        "text": "\u201cThe files are alpha.txt and beta.md.\u201d\n",
        "phase": "commentary"
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "commandExecution",
        "id": "exec-8b6adb9d-5beb-435c-8116-d566bf6555e1",
        "command": "/usr/bin/zsh -lc 'echo done'",
        "status": "inProgress",
        "commandActions": [
          {
            "type": "unknown",
            "command": "echo done"
          }
        ],
        "aggregatedOutput": "done\n",
        "exitCode": null,
        "durationMs": null
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "commandExecution",
        "id": "exec-8b6adb9d-5beb-435c-8116-d566bf6555e1",
        "command": "/usr/bin/zsh -lc 'echo done'",
        "status": "completed",
        "commandActions": [
          {
            "type": "unknown",
            "command": "echo done"
          }
        ],
        "aggregatedOutput": "done\n",
        "exitCode": 0,
        "durationMs": 0
      }
    }
  ],
  [
    "item/started",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_043ea5034e45b312016aa96308b7f087d0b565a5dda9c8cc2e",
        "text": "",
        "phase": "final_answer"
      }
    }
  ],
  [
    "item/completed",
    {
      "threadId": "ROOT",
      "turnId": "t1",
      "item": {
        "type": "agentMessage",
        "id": "msg_043ea5034e45b312016aa96308b7f087d0b565a5dda9c8cc2e",
        "text": "The subagent\u2019s answer is quoted above, and `echo done` completed.",
        "phase": "final_answer"
      }
    }
  ],
  [
    "turn/completed",
    {
      "threadId": "ROOT",
      "turn": {
        "id": "t1",
        "status": "completed"
      }
    }
  ]
];
